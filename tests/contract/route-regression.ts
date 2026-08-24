import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadActiveProfile,
  loadWorkflowPaths,
  resolveWorkflowLocator,
  workflowRelativePath,
} from '../../src/config/workflow-config.js';
import { workflowRoot } from '../../src/config/workspace-paths.js';
import {
  createPatchForNewFile,
  getAddedLines,
} from '../../src/validators/check-js-diff.js';
import { validateTaskArtifactsById } from '../../src/validators/check-task-artifacts.js';
import { classifyRouteFacts } from '../../src/core/classify-route.js';
import {
  buildRoutePacket,
  formatRoutePacket,
  loadRoutes,
  materializeRoutePacket,
  validateRoutes,
  workspaceRoot,
} from '../../src/core/context-budget.js';
import type { BuildRoutePacketOptions } from '../../src/core/context-budget.js';
import {
  buildFactExtractionChallenge,
  evaluateFactExtractions,
} from '../../src/core/fact-extraction-eval.js';
import type { FactPredictionSet } from '../../src/core/fact-extraction-eval.js';
import {
  guardMicroChangeScope,
  isInitialRouteStage,
  readArguments,
  readRouteArguments,
  renderRouteOutput,
  validateImplementationApproval,
  validateRunLineage,
} from '../../src/core/route.js';
import {
  analyzeMicroChangePatch,
  guardMicroChangePatch,
  guardMicroRepository,
  validateMicroChangeRun,
} from '../../src/core/micro-change-guard.js';
import type { MicroRunEvent } from '../../src/core/micro-change-guard.js';
import {
  guardMicroBriefContent,
  validateMicroBrief,
} from '../../src/core/micro-brief.js';
import { materializeRouteCase } from '../../src/core/route-eval.js';
import type { RouteEvalSuite } from '../../src/core/route-eval.js';
import {
  renderRoutesDocument,
  renderRoutesTable,
} from '../../src/core/render-routes.js';
import type { RouteFacts } from '../../src/types/contracts.js';
import { errorMessage } from '../../src/types/guards.js';
import { validateRouteTaskState } from '../../src/core/task-route-guard.js';
import { readWorkflowInputFile } from '../../src/core/workflow-input.js';
import {
  buildNextRouteArguments,
  deriveNextRouteFromModel,
  readNextArguments,
} from '../../src/core/workflow-next.js';

const activeProfile = loadActiveProfile();
const providerBinding = activeProfile.sourceProviders[
  activeProfile.taskModel.providerEntryMode
];
const providerSkill = providerBinding?.kind === 'skill'
  ? providerBinding.name
  : '';
const reviewSkill = activeProfile.review.defaultSkill;
const regressionBriefPath = workflowRelativePath('runtimeRoot', 'briefs', 'change.json');
const regressionPatchPath = workflowRelativePath('runtimeRoot', 'patches', 'change.patch');
const regressionExamplePath = path
  .relative(
    workspaceRoot,
    path.join(
      workflowRoot,
      'resources',
      'examples',
      'micro-change-brief.sample.json',
    ),
  )
  .split(path.sep)
  .join('/');
const regressionExamplePrefix = `${path.posix.dirname(regressionExamplePath)}/`;

const skillScenarios = [
  {
    entry: 'pool',
    route: 'pool-capture',
    skills: providerSkill ? [providerSkill] : [],
    stage: 'capture',
  },
  {
    entry: 'direct',
    route: 'micro-change',
    skills: reviewSkill ? [reviewSkill] : [],
    stage: 'locate-requirement',
  },
  {
    entry: 'pool',
    route: 'standard-change',
    skills: [],
    stage: 'capture',
  },
  {
    entry: 'direct',
    route: 'analysis',
    skills: [],
    stage: 'analyze',
  },
  {
    entry: 'pool',
    route: 'review-only',
    skills: reviewSkill ? [reviewSkill] : [],
    stage: 'review',
  },
  {
    entry: 'not-applicable',
    route: 'workflow-maintenance',
    skills: reviewSkill ? [reviewSkill] : [],
    stage: 'review',
  },
  {
    entry: 'not-applicable',
    route: 'git-only',
    skills: [],
    stage: 'inspect',
  },
  {
    entry: 'pool',
    route: 'portable-resume',
    skills: [],
    stage: 'resume',
  },
];

const forbiddenStartupDocs = new Set(loadRoutes().denyEagerDocs);

const standardImplementManifest = `# Task Manifest

## Identity
- Schema Version: 1
- Task ID: 20260728-route-guard-regression
- Run ID: run-0123456789abcdef
- Route ID: standard-change
- Status: in_progress
- Current Stage: Implement
- State Mode: Conversation
- Last Updated: 2026-07-28T00:00:00.000Z

## Source Record
- Entry Mode: direct

## Stage Status
| Stage | Status | Artifact / Reason |
|-------|--------|-------------------|
| Source Capture | complete | source.md |
| Intake | complete | intake.md |
| PRD | skipped | not required |
| Spec | complete | spec.md |
| Plan | complete | plan ready |
| Implement | in_progress | implement |
| Review | pending | |
| Verify | pending | |
| Git Inspect | pending | |

## Resume
- Next Pending Stage: Implement
`;

const standardArtifacts = {
  'intake.md': '# Intake',
  'plan.md': '# Plan',
  'source.md': '# Source',
  'spec.md': `---
status: confirmed
---
# Spec`,
};

const analysisManifest = `# Task Manifest

## Identity
- Schema Version: 1
- Task ID: 20260729-analysis-route-regression
- Run ID: run-abcdef0123456789
- Route ID: analysis
- Status: in_progress
- Current Stage: Analyze
- State Mode: Portable
- Last Updated: 2026-07-29T00:00:00.000Z

## Source Record
- Entry Mode: direct

## Stage Status
| Stage | Status | Artifact / Reason |
|-------|--------|-------------------|
| Source Capture | complete | source.md |
| Intake | complete | intake.md |
| Analyze | in_progress | analyze |

## Resume
- Next Pending Stage: Analyze
`;

function withClassification(
  scenario: Omit<BuildRoutePacketOptions, 'classification'> & {
    route: 'micro-change';
  },
): BuildRoutePacketOptions & { classification: NonNullable<
  BuildRoutePacketOptions['classification']
> };
function withClassification(
  scenario: Omit<BuildRoutePacketOptions, 'classification'>,
): BuildRoutePacketOptions;
function withClassification(
  scenario: Omit<BuildRoutePacketOptions, 'classification'>,
): BuildRoutePacketOptions {
  if (scenario.route !== 'micro-change') {
    return scenario;
  }
  const changeType = scenario.stage.includes('requirement')
    ? 'requirement'
    : 'defect';
  const facts = {
    acceptanceClear: true,
    behaviorClear: changeType === 'requirement',
    changeType,
    compatibilityClear: changeType === 'requirement',
    entry: scenario.entry,
    files: 1,
    goalClear: true,
    hasValidationPath: true,
    intent: 'change',
    noNewBusinessState: changeType === 'requirement',
    repositories: 1,
    semanticLines: 2,
    uniqueLocation: true,
    usesExistingPattern: changeType === 'requirement',
  };
  return {
    ...scenario,
    classification: classifyRouteFacts(facts),
  };
}

/** Exercises the portable route matrix and all safety/lineage contracts. */
export const main = () => {
  try {
    const config = loadRoutes();
    const routeDocument = [
      '# Routes',
      '',
      renderRoutesTable(config),
      '',
    ].join('\n');
    assert.equal(renderRoutesDocument(routeDocument, config), routeDocument);
    const windowsRouteDocument = routeDocument.replaceAll('\n', '\r\n');
    assert.equal(
      renderRoutesDocument(windowsRouteDocument, config),
      windowsRouteDocument,
    );
    const matrixScenarios = Object.entries(config.routes)
      .flatMap(([routeName, route]) =>
        route.entryModes.flatMap((entry) =>
          Object.keys(route.stages).map((stage) => ({
            entry,
            route: routeName,
            stage,
          }))));
    const packets = [...matrixScenarios, ...skillScenarios]
      .map(withClassification)
      .map(buildRoutePacket);
    packets.forEach((packet) => {
      assert.ok(packet.usedChars <= packet.budgetChars);
      assert.equal(
        packet.decision.confidence,
        packet.route === 'micro-change' ? 1 : null,
      );
      assert.equal(
        packet.decision.confidenceBasis,
        packet.route === 'micro-change'
          ? 'structured-facts'
          : 'manual-route-selection',
      );
      assert.ok(packet.decision.reasonCodes.length > 0);
      assert.equal(packet.routesVersion, config.version);
      assert.ok(packet.decision.onFailure);
      assert.equal(
        packet.materializeDocs.some((relativePath) =>
          config.baseDocs.includes(relativePath)),
        false,
      );
      packet.instructionDocs.forEach((relativePath) => {
        assert.equal(
          forbiddenStartupDocs.has(relativePath),
          false,
          `${packet.route}/${packet.stage} eager-loads ${relativePath}`,
        );
      });
    });
    const referenceScenarios = Object.entries(config.routes)
      .flatMap(([routeName, route]) =>
        route.entryModes.flatMap((entry) =>
          Object.entries(route.stages)
            .flatMap(([stage, stageDefinition]) =>
              (stageDefinition.references || []).map((reference) => ({
                entry,
                reference,
                route: routeName,
                stage,
              })))));
    referenceScenarios.forEach(({
      entry,
      reference,
      route,
      stage,
    }) => {
      const packet = buildRoutePacket(withClassification({
        entry,
        references: [reference],
        route,
        stage,
      }));
      assert.deepEqual(packet.referenceDocs, [reference]);
      assert.ok(packet.usedChars <= packet.budgetChars);
    });
    const referenceCombinationPacket = buildRoutePacket({
      entry: 'not-applicable',
      references: [
        'workflow:README.md#启动与任务分流',
        'workflow:README.md#质量门禁',
        'workflow:README.md#分层',
        'workflow:docs/security-boundaries.md',
      ],
      route: 'workflow-maintenance',
      stage: 'inspect',
    });
    assert.equal(referenceCombinationPacket.referenceDocs.length, 4);
    assert.ok(
      referenceCombinationPacket.packetChars <=
        referenceCombinationPacket.packetReserveChars,
    );
    assert.ok(
      referenceCombinationPacket.usedChars <=
        referenceCombinationPacket.budgetChars,
    );

    assert.throws(
      () => buildRoutePacket({
        entry: 'not-applicable',
        route: 'micro-change',
        stage: 'locate-defect',
      }),
      /不接受 Entry/,
    );
    assert.throws(
      () => buildRoutePacket({
        entry: 'direct',
        route: 'micro-change',
        stage: 'unknown',
      }),
      /不包含 Stage/,
    );
    assert.throws(
      () => buildRoutePacket({
        entry: 'direct',
        classification: withClassification({
          entry: 'direct',
          route: 'micro-change',
          stage: 'locate-defect',
        }).classification,
        route: 'micro-change',
        skills: ['missing-skill'],
        stage: 'locate-defect',
      }),
      /Skill 不存在/,
    );
    assert.throws(
      () => buildRoutePacket({
        classification: {
          ...withClassification({
            entry: 'direct',
            route: 'micro-change',
            stage: 'locate-defect',
          }).classification,
          riskFlags: ['interface-change'],
        },
        entry: 'direct',
        route: 'micro-change',
        stage: 'locate-defect',
      }),
      /禁止风险标识/,
    );
    assert.throws(
      () => buildRoutePacket({
        entry: 'direct',
        riskFlags: ['invented-risk'],
        route: 'standard-change',
        stage: 'capture',
      }),
      /未知 Risk Flag/,
    );
    assert.throws(
      () => buildRoutePacket({
        entry: 'direct',
        route: 'standard-change',
        stage: 'capture',
        taskId: '../invalid',
      }),
      /Task ID 只能包含/,
    );
    const prdReferencePacket = buildRoutePacket({
      entry: 'direct',
      references: ['workflow:docs/02-prd.md'],
      route: 'standard-change',
      stage: 'prd',
    });
    assert.deepEqual(
      prdReferencePacket.referenceDocs,
      ['workflow:docs/02-prd.md'],
    );
    assert.ok(
      prdReferencePacket.instructionDocs.includes('workflow:docs/02-prd.md'),
    );
    assert.throws(
      () => buildRoutePacket({
        entry: 'direct',
        references: ['workflow:docs/08-git.md'],
        route: 'standard-change',
        stage: 'prd',
      }),
      /不允许 Reference/,
    );

    const eagerConfig = JSON.parse(JSON.stringify(config));
    eagerConfig.baseDocs.push('workflow:README.md');
    assert.match(
      validateRoutes(eagerConfig).errors.join('\n'),
      /禁止把深度参考加入启动链/,
    );

    const lowBudgetConfig = JSON.parse(JSON.stringify(config));
    lowBudgetConfig.routes['micro-change'].budgetChars = 100;
    assert.match(
      validateRoutes(lowBudgetConfig).errors.join('\n'),
      /超过预算/,
    );
    const invalidStagePathConfig = JSON.parse(JSON.stringify(config));
    invalidStagePathConfig.routes['micro-change'].stagePaths.defect[0] =
      'missing-stage';
    assert.match(
      validateRoutes(invalidStagePathConfig).errors.join('\n'),
      /未知 Stage missing-stage/,
    );
    const missingSectionConfig = JSON.parse(JSON.stringify(config));
    missingSectionConfig.routes['pool-capture'].references.push(
      'workflow:docs/source-capture.md#missing-section',
    );
    missingSectionConfig.routes['pool-capture'].stages.capture.references.push(
      'workflow:docs/source-capture.md#missing-section',
    );
    assert.match(
      validateRoutes(missingSectionConfig).errors.join('\n'),
      /Markdown 章节不存在/,
    );
    const missingTaskStagesConfig = JSON.parse(JSON.stringify(config));
    delete missingTaskStagesConfig.routes.analysis.stages.capture.taskStages;
    assert.match(
      validateRoutes(missingTaskStagesConfig).errors.join('\n'),
      /taskFlow 路由必须登记 taskStages/,
    );
    const invalidWarningRatioConfig = JSON.parse(JSON.stringify(config));
    invalidWarningRatioConfig.limits.routeWarningRemainingRatio = 1;
    assert.match(
      validateRoutes(invalidWarningRatioConfig).errors.join('\n'),
      /routeWarningRemainingRatio/,
    );
    const invalidMicroGateConfig = JSON.parse(JSON.stringify(config));
    invalidMicroGateConfig.microChangeGate.maxFiles = 0;
    assert.match(
      validateRoutes(invalidMicroGateConfig).errors.join('\n'),
      /microChangeGate\.maxFiles/,
    );

    const materializePacket = buildRoutePacket(withClassification({
      entry: 'direct',
      route: 'micro-change',
      stage: 'locate-defect',
    }));
    const materializedText = materializeRoutePacket(materializePacket, 'text');
    assert.equal(materializedText.complete, true);
    assert.ok(materializedText.outputChars <= materializePacket.toolOutputDefaultChars);
    assert.match(materializedText.output, /^Runtime Context: micro-change\/locate-defect/);
    assert.doesNotMatch(materializedText.output, /^Route Packet/);
    assert.match(materializedText.output, /# Micro Change Card/);
    assert.match(materializedText.output, /# Implementation Approval Card/);
    assert.match(materializedText.output, /# Defect Intent Card/);
    assert.match(materializedText.output, /设计根因/);
    assert.match(materializedText.output, /责任层/);
    assert.match(materializedText.output, /最小完整语义闭环/);
    assert.match(materializedText.output, /同类或后续扩展场景/);
    assert.match(materializedText.output, /只过当前案例/);
    assert.doesNotMatch(materializedText.output, /# AI Workflow Bootstrap\n/);
    const materializedJson = materializeRoutePacket(materializePacket, 'json');
    const parsedMaterializedJson = JSON.parse(materializedJson.output);
    assert.equal(parsedMaterializedJson.materializationComplete, true);
    assert.equal(parsedMaterializedJson.materializedContext.length, 4);
    const standardPlanPacket = buildRoutePacket({
      entry: 'direct',
      route: 'standard-change',
      stage: 'spec-plan',
    });
    const materializedStandardPlan = materializeRoutePacket(
      standardPlanPacket,
      'text',
    );
    assert.equal(materializedStandardPlan.complete, true);
    assert.match(materializedStandardPlan.output, /# Spec \/ Plan Card/);
    assert.match(materializedStandardPlan.output, /# Implementation Approval Card/);
    assert.match(materializedStandardPlan.output, /规则责任层|说明归属和理由/);
    assert.match(materializedStandardPlan.output, /表象补丁/);
    const sectionPacket = buildRoutePacket({
      entry: 'direct',
      references: ['workflow:docs/source-capture.md#direct-entry'],
      route: 'standard-change',
      stage: 'capture',
    });
    const materializedSection = materializeRoutePacket(sectionPacket, 'text');
    assert.match(materializedSection.output, /## Direct Entry/);
    assert.doesNotMatch(materializedSection.output, /## Pool Entry/);
    const partialMaterialization = materializeRoutePacket({
      ...materializePacket,
      toolOutputDefaultChars: materializedText.outputChars - 1,
    }, 'text');
    assert.equal(partialMaterialization.complete, false);
    assert.ok(partialMaterialization.materializedDocs.length > 0);
    assert.ok(partialMaterialization.omittedDocs.length > 0);
    assert.ok(
      partialMaterialization.outputChars < materializedText.outputChars,
    );
    assert.deepEqual(
      partialMaterialization.materializedDocs,
      materializePacket.materializeDocs.slice(
        0,
        partialMaterialization.materializedDocs.length,
      ),
    );
    assert.deepEqual(
      partialMaterialization.omittedDocs,
      materializePacket.materializeDocs.slice(
        partialMaterialization.materializedDocs.length,
      ),
    );
    assert.match(partialMaterialization.output, /Materialization: partial/);
    assert.match(partialMaterialization.output, /Remaining Context Docs:/);
    const partialJson = materializeRoutePacket({
      ...materializePacket,
      toolOutputDefaultChars: materializedJson.outputChars - 1,
    }, 'json');
    const parsedPartialJson = JSON.parse(partialJson.output);
    assert.equal(parsedPartialJson.materializationComplete, false);
    assert.ok(parsedPartialJson.materializedContext.length > 0);
    assert.ok(parsedPartialJson.omittedMaterializeDocs.length > 0);
    assert.throws(
      () => materializeRoutePacket({
        ...materializePacket,
        toolOutputDefaultChars: 100,
      }, 'text'),
      /超过工具输出上限/,
    );
    const fallbackOutput = renderRouteOutput({
      ...materializePacket,
      toolOutputDefaultChars: 100,
    }, {
      format: 'text',
      materializeContext: true,
    });
    assert.equal(fallbackOutput.fallbackCode, 'tool-output-exceeded');
    assert.equal(fallbackOutput.materialized, false);
    assert.match(fallbackOutput.output, /^Route Packet/);
    assert.match(fallbackOutput.warning, /自动回退为普通 Route Packet/);
    const partialRouteOutput = renderRouteOutput({
      ...materializePacket,
      toolOutputDefaultChars: materializedText.outputChars - 1,
    }, {
      format: 'text',
      materializeContext: true,
    });
    assert.equal(partialRouteOutput.fallbackCode, 'partial-materialize');
    assert.equal(partialRouteOutput.materializationRequested, true);
    assert.equal(partialRouteOutput.materializationComplete, false);
    assert.equal(partialRouteOutput.materialized, true);
    assert.ok(partialRouteOutput.materializedDocsCount > 0);
    assert.ok(partialRouteOutput.omittedDocsCount > 0);
    assert.equal(partialRouteOutput.warning, '');

    assert.equal(
      readArguments(['--materialize-context']).materializeContext,
      true,
    );
    assert.equal(
      readArguments(['--materialize']).materializeContext,
      true,
    );
    assert.equal(readArguments(['--user-approved']).userApproved, true);
    const nextArguments = readNextArguments([
      '--task', 'sample-task', '--materialize', '--user-approved',
    ]);
    assert.equal(nextArguments.taskId, 'sample-task');
    assert.deepEqual(nextArguments.remainingArgs, ['--materialize', '--user-approved']);
    assert.throws(
      () => readNextArguments(['--task', 'sample-task', '--stage', 'review']),
      /由 manifest 推导/,
    );
    assert.throws(
      () => readNextArguments(['--task', 'sample-task', '--task', 'other-task']),
      /只能提供一个/,
    );
    const nextRoute = deriveNextRouteFromModel({
      currentStage: 'Implement',
      entryMode: 'direct',
      routeId: 'standard-change',
      runId: 'run-0123456789abcdef',
    }, 'sample-task', config);
    assert.deepEqual(nextRoute, {
      entry: 'direct',
      route: 'standard-change',
      runId: 'run-0123456789abcdef',
      stage: 'implement',
      taskId: 'sample-task',
    });
    assert.deepEqual(
      buildNextRouteArguments(nextRoute, ['--materialize']),
      [
        '--route', 'standard-change',
        '--stage', 'implement',
        '--entry', 'direct',
        '--task', 'sample-task',
        '--materialize',
      ],
    );
    assert.throws(
      () => validateImplementationApproval({
        route: 'micro-change',
        stage: 'implement',
      }),
      /Implementation Approval Gate/,
    );
    assert.throws(
      () => validateImplementationApproval({
        route: 'standard-change',
        stage: 'implement',
      }),
      /Implementation Approval Gate/,
    );
    assert.doesNotThrow(() => validateImplementationApproval({
      route: 'micro-change',
      stage: 'implement',
      userApproved: true,
    }));
    assert.throws(
      () => validateImplementationApproval({
        route: 'micro-change',
        stage: 'locate-defect',
        userApproved: true,
      }),
      /只允许用于/,
    );
    const fileArguments = readArguments([
      '--micro-brief-file', regressionBriefPath,
      '--micro-patch-file', regressionPatchPath,
      '--parent-run-id', 'run-abcdef0123456789',
    ]);
    assert.equal(
      fileArguments.microBriefFile,
      regressionBriefPath,
    );
    assert.equal(
      fileArguments.microPatchFile,
      regressionPatchPath,
    );
    assert.equal(fileArguments.parentRunId, 'run-abcdef0123456789');
    const classifiedArguments = readRouteArguments([
      '--route', 'micro-change',
      '--stage', 'locate-defect',
      '--entry', 'direct',
      '--intent', 'defect',
      '--goal-clear',
      '--acceptance-clear',
      '--unique-location',
      '--repositories', '1',
      '--files', '1',
      '--semantic-lines', '2',
      '--validation-path',
    ]);
    const classificationFacts = classifiedArguments.classificationFacts;
    assert.ok(classificationFacts);
    assert.equal(classificationFacts.intent, 'defect');
    assert.equal(classifiedArguments.entry, 'direct');
    const locateClassification = classifyRouteFacts(
      classificationFacts,
    );
    const locateScope = guardMicroChangeScope({
      microBriefFile: '',
      microPatchFile: '',
      microPatchStdin: false,
      repository: '.',
      route: 'micro-change',
      runId: 'run-0123456789abcdef',
      stage: 'locate-defect',
    }, locateClassification, true, []);
    assert.ok(locateScope.microRepository);
    assert.equal(locateScope.microRepository.repository, '.');
    assert.match(locateScope.microRepository.repositoryId, /^[a-f0-9]{12}$/);
    const runtimeRoot = loadWorkflowPaths().runtimeRoot;
    mkdirSync(runtimeRoot, { recursive: true });
    const nestedRepositoryRoot = mkdtempSync(
      path.join(runtimeRoot, 'route-repository-'),
    );
    mkdirSync(path.join(nestedRepositoryRoot, '.git'));
    const nativeRepositoryPath = path.relative(workspaceRoot, nestedRepositoryRoot);
    const nestedRepositoryPath = nativeRepositoryPath.split(path.sep).join('/');
    try {
      const nestedRepository = guardMicroRepository(nestedRepositoryPath);
      assert.ok(nestedRepository);
      assert.equal(nestedRepository.repository, nestedRepositoryPath);
      assert.equal(
        nestedRepository.repositoryId,
        createHash('sha256')
          .update(nativeRepositoryPath)
          .digest('hex')
          .slice(0, 12),
      );
    } finally {
      rmSync(nestedRepositoryRoot, { force: true, recursive: true });
    }
    assert.throws(
      () => guardMicroRepository('../outside'),
      /--repository 越界/,
    );
    assert.throws(
      () => guardMicroChangeScope({
        microBriefFile: regressionBriefPath,
        microPatchFile: regressionPatchPath,
        microPatchStdin: false,
        repository: '',
        route: 'micro-change',
        runId: 'run-0123456789abcdef',
        stage: 'review-defect',
      }, locateClassification, false, []),
      /必须使用 --repository/,
    );
    const repositoryPacket = buildRoutePacket({
      classification: locateClassification,
      entry: 'direct',
      microRepository: locateScope.microRepository,
      route: 'micro-change',
      stage: 'locate-defect',
    });
    assert.match(formatRoutePacket(repositoryPacket), /location-hint/);
    assert.equal(
      isInitialRouteStage(
        { route: 'micro-change', stage: 'locate-defect' },
        classifyRouteFacts(classificationFacts),
      ),
      true,
    );
    assert.equal(
      isInitialRouteStage(
        { route: 'workflow-maintenance', stage: 'review' },
        null,
      ),
      false,
    );
    const microPatch = [
      'diff --git a/example.js b/example.js',
      '--- a/example.js',
      '+++ b/example.js',
      '@@ -1 +1 @@',
      '-const value = 1;',
      '+const value = 2;',
      '',
    ].join('\n');
    assert.deepEqual(
      analyzeMicroChangePatch(microPatch),
      {
        blockers: [],
        fileCount: 1,
        files: ['example.js'],
        patchHash: analyzeMicroChangePatch(microPatch).patchHash,
        semanticLines: 2,
      },
    );
    assert.equal(
      analyzeMicroChangePatch(
        microPatch.replace(
          '-const value = 1;',
          '--- content that resembles a file header',
        ).replace(
          '+const value = 2;',
          '+++ content that resembles a file header',
        ),
      ).semanticLines,
      2,
    );
    assert.deepEqual(
      analyzeMicroChangePatch(
        createPatchForNewFile('const value = 1;\n', 'new-file.js'),
      ),
      {
        blockers: [],
        fileCount: 1,
        files: ['new-file.js'],
        patchHash: analyzeMicroChangePatch(
          createPatchForNewFile('const value = 1;\n', 'new-file.js'),
        ).patchHash,
        semanticLines: 1,
      },
    );
    assert.equal(
      getAddedLines(
        createPatchForNewFile('++counter;\n', 'increment.js'),
      )[0]?.text,
      '++counter;',
    );
    assert.match(
      analyzeMicroChangePatch(
        [
          'diff --git a/example.js b/example.js',
          '--- a/example.js',
          '+++ b/example.js',
          '@@ -1,21 +1 @@',
          ...Array.from({ length: 21 }, (_, index) => `-line ${index}`),
          '+replacement',
          '',
        ].join('\n'),
      ).blockers.join(','),
      /actual-semantic-lines/,
    );
    assert.throws(
      () => analyzeMicroChangePatch([
        'diff --git a/a.js b/a.js',
        '--- a/a.js',
        '+++ b/a.js',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '--- a/hidden.js',
        '+++ b/hidden.js',
        '@@ -1 +1 @@',
        '-c',
        '+d',
        '',
      ].join('\n')),
      /重复或孤立的旧文件头/,
    );
    assert.throws(
      () => analyzeMicroChangePatch([
        'diff --git a/../outside.js b/../outside.js',
        '--- a/../outside.js',
        '+++ b/../outside.js',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n')),
      /非法或越界文件路径/,
    );
    assert.equal(
      analyzeMicroChangePatch([
        'diff --git "a/\\344\\270\\255.js" "b/\\344\\270\\255.js"',
        '--- "a/\\344\\270\\255.js"',
        '+++ "b/\\344\\270\\255.js"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n')).fileCount,
      1,
    );

    const gitCalls: Array<{ args: string[]; cwd: string; input: string }> = [];
    const guardedPatch = guardMicroChangePatch(
      {
        patch: microPatch,
        repository: '.',
      },
      config,
      {
        runGit: ({ args, cwd, input = '' }) => {
          gitCalls.push({ args, cwd, input });
          return args.includes('rev-parse')
            ? { status: 0, stdout: `${'a'.repeat(40)}\n` }
            : { status: 0, stdout: '' };
        },
      },
    );
    assert.equal(guardedPatch.sourceMode, 'repository-reverse-check');
    assert.match(guardedPatch.sourceHash, /^[a-f0-9]{16}$/);
    assert.equal(gitCalls.length, 2);
    assert.equal(gitCalls[0]?.cwd, workspaceRoot);
    assert.deepEqual(
      gitCalls[0]?.args,
      ['apply', '--reverse', '--check', '--whitespace=nowarn', '-'],
    );
    assert.equal(gitCalls[0]?.input, microPatch);
    assert.throws(
      () => guardMicroChangePatch(
        { patch: microPatch, repository: '.' },
        config,
        { runGit: () => ({ status: 1, stdout: '' }) },
      ),
      /Micro Change Source Gate: patch 与仓库当前内容不一致/,
    );
    assert.throws(
      () => guardMicroChangePatch(
        { patch: microPatch, repository: '.' },
        config,
        {
          runGit: ({ args }) => args.includes('rev-parse')
            ? { status: 1, stdout: '' }
            : { status: 0, stdout: '' },
        },
      ),
      /Micro Change Source Gate: 无法确认仓库 HEAD/,
    );

    const microBriefContent = readFileSync(
      path.join(
        workflowRoot,
        'resources',
        'examples',
        'micro-change-brief.sample.json',
      ),
      'utf8',
    );
    const implementBrief = JSON.parse(microBriefContent);
    assert.deepEqual(validateMicroBrief(implementBrief, 'implement'), []);
    assert.match(
      validateMicroBrief(implementBrief, 'implement', {
        repository: 'src/other',
      }).join('\n'),
      /Change Inventory Repository 与 --repository 不一致/,
    );
    const implementBriefGuard = guardMicroBriefContent({
      content: microBriefContent,
      stage: 'implement',
    });
    assert.match(implementBriefGuard.planHash, /^[a-f0-9]{16}$/);
    const prematureBrief = structuredClone(implementBrief);
    prematureBrief.changeInventory[0].actualChange = '尚未发生的实际改动';
    prematureBrief.verificationMatrix[0].status = 'passed';
    prematureBrief.verificationMatrix[0].evidenceOrGap = '尚未执行的证据';
    assert.match(
      validateMicroBrief(prematureBrief, 'implement').join('\n'),
      /Implement 阶段必须为空|Implement 阶段必须为 planned/,
    );
    const reviewBrief = structuredClone(implementBrief);
    reviewBrief.changeInventory[0].actualChange =
      '已完成计划中的最小语义改动';
    const reviewBriefGuard = guardMicroBriefContent({
      content: JSON.stringify(reviewBrief),
      patchFiles: ['path/to/file.js'],
      repository: 'src/example',
      stage: 'review-defect',
    });
    assert.equal(reviewBriefGuard.planHash, implementBriefGuard.planHash);
    assert.notEqual(reviewBriefGuard.briefHash, implementBriefGuard.briefHash);
    const finalBrief = structuredClone(reviewBrief);
    finalBrief.verificationMatrix[0].status = 'passed';
    finalBrief.verificationMatrix[0].evidenceOrGap = '静态门禁检查通过';
    assert.deepEqual(validateMicroBrief(finalBrief, 'git-inspect', {
      patchFiles: ['path/to/file.js'],
      repository: 'src/example',
    }), []);
    assert.throws(
      () => guardMicroBriefContent({
        content: JSON.stringify(reviewBrief),
        patchFiles: ['unexpected.js'],
        repository: 'src/example',
        stage: 'review-defect',
      }),
      /Change Inventory 文件与任务 patch 不一致/,
    );
    const orphanedBrief = structuredClone(implementBrief);
    orphanedBrief.changeInventory[0].acceptanceCriteria = ['AC2'];
    assert.match(
      validateMicroBrief(orphanedBrief, 'implement').join('\n'),
      /未知 AC AC2|AC1 未映射 Change Inventory/,
    );
    const malformedBrief = structuredClone(implementBrief);
    malformedBrief.changeInventory = [null];
    assert.doesNotThrow(() => validateMicroBrief(malformedBrief, 'implement'));
    assert.match(
      validateMicroBrief(malformedBrief, 'implement').join('\n'),
      /changeInventory\[0\] 必须是对象/,
    );
    const sensitiveBrief = structuredClone(implementBrief);
    sensitiveBrief.goalAlignment.goals[0].text = 'token=abc123';
    assert.throws(
      () => guardMicroBriefContent({
        content: JSON.stringify(sensitiveBrief),
        stage: 'implement',
      }),
      /疑似凭据或敏感参数/,
    );
    assert.equal(
      readWorkflowInputFile(
        regressionExamplePath,
        {
          allowedPrefix: regressionExamplePrefix,
          maxBytes: 64 * 1024,
        },
      ).displayPath,
      regressionExamplePath,
    );
    assert.throws(
      () => readWorkflowInputFile('../outside.patch', { maxBytes: 1024 }),
      /路径越界/,
    );

    const parentRunId = 'run-fedcba9876543210';
    const childRunId = 'run-abcdef0123456789';
    const parentEvents = [{
      result: 'success',
      route: 'pool-capture',
      runId: parentRunId,
      stage: 'capture',
    }];
    assert.throws(() => validateRunLineage({
      createdRunId: false,
      events: parentEvents,
      initialStage: true,
      route: 'micro-change',
      runId: parentRunId,
    }), /Run Route Gate/);
    assert.doesNotThrow(() => validateRunLineage({
      createdRunId: true,
      events: parentEvents,
      initialStage: true,
      parentRunId,
      route: 'micro-change',
      runId: childRunId,
    }));
    assert.throws(() => validateRunLineage({
      createdRunId: false,
      events: parentEvents,
      initialStage: false,
      parentRunId,
      route: 'micro-change',
      runId: childRunId,
    }), /只允许在新 Route 首阶段/);
    assert.throws(() => validateRunLineage({
      createdRunId: true,
      events: [],
      initialStage: true,
      parentRunId,
      route: 'micro-change',
      runId: childRunId,
    }), /Parent Run 不存在/);
    assert.throws(() => validateRunLineage({
      createdRunId: true,
      events: [{
        result: 'success',
        route: 'micro-change',
        runId: parentRunId,
      }],
      initialStage: true,
      parentRunId,
      route: 'micro-change',
      runId: childRunId,
    }), /只用于切换 Route/);

    const microRunId = 'run-0123456789abcdef';
    const microBriefPlanHash = '1122334455667788';
    const microRunEvents: MicroRunEvent[] = [
      {
        changeType: 'defect',
        microPatchHash: 'none',
        microRepositoryId: 'none',
        result: 'success',
        route: 'micro-change',
        runId: microRunId,
        stage: 'locate-defect',
      },
      {
        changeType: 'defect',
        microBriefPlanHash,
        microPatchHash: 'none',
        microRepositoryId: 'none',
        result: 'success',
        route: 'micro-change',
        runId: microRunId,
        stage: 'implement',
      },
    ];
    assert.doesNotThrow(() => validateMicroChangeRun({
      briefPlanHash: microBriefPlanHash,
      changeType: 'defect',
      events: microRunEvents,
      patchHash: '0123456789abcdef',
      repositoryId: '0123456789ab',
      runId: microRunId,
      sourceHash: 'abcdef0123456789',
      stage: 'review-defect',
    }, config));
    assert.throws(() => validateMicroChangeRun({
      briefPlanHash: microBriefPlanHash,
      changeType: 'defect',
      events: microRunEvents.slice(0, 1),
      patchHash: '0123456789abcdef',
      repositoryId: '0123456789ab',
      runId: microRunId,
      sourceHash: 'abcdef0123456789',
      stage: 'review-defect',
    }, config), /缺少前置阶段 implement/);
    assert.throws(() => validateMicroChangeRun({
      changeType: 'defect',
      events: [],
      runId: microRunId,
      stage: 'locate-defect',
    }, config), /首阶段 Run ID 不存在/);
    const reviewedMicroEvents = microRunEvents.concat({
      changeType: 'defect',
      microBriefPlanHash,
      microPatchHash: '0123456789abcdef',
      microRepositoryId: '0123456789ab',
      microSourceHash: 'abcdef0123456789',
      result: 'success',
      route: 'micro-change',
      runId: microRunId,
      stage: 'review-defect',
    });
    assert.throws(() => validateMicroChangeRun({
      briefPlanHash: microBriefPlanHash,
      changeType: 'defect',
      events: reviewedMicroEvents,
      patchHash: 'fedcba9876543210',
      repositoryId: '0123456789ab',
      runId: microRunId,
      sourceHash: 'abcdef0123456789',
      stage: 'verify-defect',
    }, config), /仓库、patch 或来源绑定已发生变化/);
    assert.throws(() => validateMicroChangeRun({
      briefPlanHash: microBriefPlanHash,
      changeType: 'defect',
      events: reviewedMicroEvents,
      patchHash: '0123456789abcdef',
      repositoryId: '0123456789ab',
      runId: microRunId,
      sourceHash: 'fedcba9876543210',
      stage: 'verify-defect',
    }, config), /来源绑定已发生变化/);
    assert.doesNotThrow(() => validateMicroChangeRun({
      briefPlanHash: microBriefPlanHash,
      changeType: 'defect',
      events: reviewedMicroEvents.map((event) => ({
        ...event,
        microSourceHash: undefined,
      })),
      patchHash: '0123456789abcdef',
      repositoryId: '0123456789ab',
      runId: microRunId,
      sourceHash: 'abcdef0123456789',
      stage: 'verify-defect',
    }, config));
    assert.throws(() => validateMicroChangeRun({
      briefPlanHash: '8877665544332211',
      changeType: 'defect',
      events: reviewedMicroEvents,
      patchHash: '0123456789abcdef',
      repositoryId: '0123456789ab',
      runId: microRunId,
      sourceHash: 'abcdef0123456789',
      stage: 'verify-defect',
    }, config), /Micro Brief 计划追踪已发生变化/);
    const routeSuite = JSON.parse(readFileSync(
      resolveWorkflowLocator(activeProfile.evals.routeCases, 'evals.routeCases'),
      'utf8',
    )) as RouteEvalSuite;
    const challenge = buildFactExtractionChallenge(routeSuite);
    assert.equal('facts' in (challenge.cases[0] ?? {}), false);
    const factsById = new Map<string, Partial<RouteFacts>>(
      routeSuite.cases.map(materializeRouteCase)
        .map(({ facts, id }) => [id, facts]),
    );
    const predictions: FactPredictionSet = {
      version: challenge.version,
      cases: challenge.cases.map(({ id, promptHash }) => ({
        facts: factsById.get(id) ?? {},
        id,
        promptHash,
      })),
    };
    assert.equal(
      evaluateFactExtractions(predictions, routeSuite, config).caseCount,
      routeSuite.cases.length,
    );
    const tamperedPredictions = structuredClone(predictions);
    const firstPrediction = tamperedPredictions.cases[0];
    assert.ok(firstPrediction);
    firstPrediction.promptHash = 'tampered';
    assert.throws(
      () => evaluateFactExtractions(tamperedPredictions, routeSuite, config),
      /promptHash 不匹配/,
    );
    assert.equal(
      validateRouteTaskState({
        entry: 'direct',
        route: 'standard-change',
        stage: 'capture',
      }),
      null,
    );
    const validTaskGate = validateRouteTaskState({
      artifacts: standardArtifacts,
      entry: 'direct',
      manifestContent: standardImplementManifest,
      route: 'standard-change',
      runId: 'run-0123456789abcdef',
      stage: 'implement',
      taskId: '20260728-route-guard-regression',
    });
    assert.ok(validTaskGate);
    assert.equal(validTaskGate.currentStage, 'Implement');
    assert.throws(
      () => validateRouteTaskState({
        artifacts: { ...standardArtifacts, 'plan.md': undefined },
        entry: 'direct',
        manifestContent: standardImplementManifest,
        route: 'standard-change',
        runId: 'run-0123456789abcdef',
        stage: 'implement',
        taskId: '20260728-route-guard-regression',
      }),
      /缺少或未填写最小 Spec 包文件 plan\.md/,
    );
    const validAnalysisTaskGate = validateRouteTaskState({
      entry: 'direct',
      manifestContent: analysisManifest,
      route: 'analysis',
      runId: 'run-abcdef0123456789',
      stage: 'analyze',
      taskId: '20260729-analysis-route-regression',
    });
    assert.ok(validAnalysisTaskGate);
    assert.equal(validAnalysisTaskGate.currentStage, 'Analyze');
    assert.throws(
      () => validateRouteTaskState({
        entry: 'direct',
        manifestContent: analysisManifest,
        route: 'analysis',
        stage: 'capture',
        taskId: '20260729-analysis-route-regression',
      }),
      /Current Stage 为 Source Capture 或 Intake/,
    );
    assert.throws(
      () => validateRouteTaskState({
        entry: 'direct',
        route: 'micro-change',
        stage: 'implement',
        taskId: '20260729-analysis-route-regression',
      }),
      /未定义 taskFlow/,
    );
    assert.throws(
      () => validateRouteTaskState({
        entry: 'direct',
        route: 'standard-change',
        stage: 'implement',
      }),
      /必须提供 --task/,
    );
    assert.throws(
      () => validateRouteTaskState({
        entry: 'direct',
        manifestContent: '# invalid manifest',
        route: 'standard-change',
        stage: 'implement',
        taskId: '20260728-route-guard-regression',
      }),
      /Task Gate: manifest 无法解析/,
    );
    assert.throws(
      () => validateRouteTaskState({
        artifacts: standardArtifacts,
        entry: 'direct',
        manifestContent: standardImplementManifest.replace(
          '- Entry Mode: direct',
          '- Entry Mode:',
        ),
        route: 'standard-change',
        stage: 'implement',
        taskId: '20260728-route-guard-regression',
      }),
      /缺少 Entry Mode/,
    );
    assert.throws(
      () => validateRouteTaskState({
        artifacts: standardArtifacts,
        entry: 'direct',
        manifestContent: standardImplementManifest,
        route: 'standard-change',
        stage: 'review',
        taskId: '20260728-route-guard-regression',
      }),
      /Current Stage 为 Review/,
    );
    assert.throws(
      () => validateRouteTaskState({
        artifacts: {
          ...standardArtifacts,
          'spec.md': standardArtifacts['spec.md'].replace(
            'status: confirmed',
            'status: conditional',
          ),
        },
        entry: 'direct',
        manifestContent: standardImplementManifest,
        route: 'standard-change',
        stage: 'implement',
        taskId: '20260728-route-guard-regression',
      }),
      /spec\.md status 必须为 confirmed/,
    );
    assert.throws(
      () => validateRouteTaskState({
        artifacts: standardArtifacts,
        entry: 'direct',
        manifestContent: standardImplementManifest,
        route: 'standard-change',
        runId: 'run-fedcba9876543210',
        stage: 'implement',
        taskId: '20260728-route-guard-regression',
      }),
      /Run ID 不一致/,
    );
    assert.throws(
      () => validateRouteTaskState({
        artifacts: {
          'intake.md': '# Intake',
          'source.md': '# Source',
        },
        entry: 'direct',
        manifestContent: standardImplementManifest,
        route: 'standard-change',
        stage: 'implement',
        taskId: '20260728-route-guard-regression',
      }),
      /缺少或未填写最小 Spec 包文件 spec\.md/,
    );
    assert.match(
      validateTaskArtifactsById('../outside-workspace').join('\n'),
      /任务目录名只能包含/,
    );

    const largestPacket = packets
      .slice()
      .sort((left, right) => right.usedChars - left.usedChars)[0];
    assert.ok(largestPacket);
    process.stdout.write(
      `路由回归检查通过：${matrixScenarios.length} 个矩阵路径、` +
      `${skillScenarios.length} 个 Skill 场景、` +
      `${referenceScenarios.length} 个 Reference 场景、` +
      '覆盖路由反例、上下文输出、分类绑定、Micro Brief / patch、Run 血缘、' +
      '文本 facts、任务门禁和参数兼容；' +
      '最大 Packet ' +
      `${largestPacket.route}/${largestPacket.stage} ` +
      `${largestPacket.usedChars}/${largestPacket.budgetChars} chars。\n`,
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`路由回归检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
