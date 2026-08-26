import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  WORKFLOW_AUTHORING_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowExecutionApproval,
} from '../../src/contracts/execution.js';
import { loadWorkflowPaths } from '../../src/config/workflow-config.js';
import { workflowRoot, workspaceRoot } from '../../src/config/workspace-paths.js';
import {
  serializeCanonicalJson,
  validateWorkflowDefinitionBundle,
} from '../../src/core/execution-plan.js';
import { FakeAgentExecutor } from '../../src/execution/fake-executor.js';
import { FileExecutionJournalStore } from '../../src/execution/file-journal.js';
import {
  createWorkflowDefinitionBundle,
  loadWorkflowDefinitionBundle,
  migrateWorkflowDefinitionArtifact,
  parseWorkflowDefinitionOutput,
  previewWorkflowDefinition,
  runApprovedWorkflow,
  validateWorkflowExecutionApproval,
  WorkflowDefinitionBuilder,
} from '../../src/execution/workflow-authoring.js';
import { errorMessage } from '../../src/types/guards.js';

const SAMPLE_DEFINITION_PATH = path.join(
  workflowRoot,
  'resources',
  'examples',
  'workflow-definition.sample.json',
);
const SAMPLE_FIXTURE_PATH = path.join(
  workflowRoot,
  'resources',
  'examples',
  'fake-executor-fixture.sample.json',
);
const cliPath = path.join(workflowRoot, 'dist', 'bin', 'agent-workflow.js');

const relativeWorkspacePath = (filePath: string): string => path
  .relative(workspaceRoot, filePath)
  .split(path.sep)
  .join('/');

const runCli = (args: string[]) => spawnSync(process.execPath, [cliPath, ...args], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  env: process.env,
  timeout: 30_000,
  windowsHide: true,
});

const approvalFor = (
  preview: ReturnType<typeof previewWorkflowDefinition>,
): WorkflowExecutionApproval => ({
  executionMode: preview.executionMode,
  previewHash: preview.previewHash,
  schemaVersion: WORKFLOW_AUTHORING_SCHEMA_VERSION,
  workflowHash: preview.workflowHash,
});

/** Guards the Phase 5 model-output, preview, approval, Builder and versioning boundary. */
export const main = async (): Promise<number> => {
  const temporaryRoot = mkdtempSync(
    path.join(loadWorkflowPaths().runtimeRoot, 'workflow-authoring-'),
  );
  const apiExecutionsRoot = path.join(temporaryRoot, 'api-executions');
  const cliRunId = `run-${randomBytes(12).toString('hex')}`;
  const cliRunRoot = path.join(
    loadWorkflowPaths().runtimeRoot,
    'executions',
    cliRunId,
  );
  try {
    const definition = JSON.parse(
      readFileSync(SAMPLE_DEFINITION_PATH, 'utf8'),
    ) as WorkflowDefinition;
    const fixture = JSON.parse(readFileSync(SAMPLE_FIXTURE_PATH, 'utf8'));

    const parsed = parseWorkflowDefinitionOutput(serializeCanonicalJson(definition));
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.nodes), true);
    assert.deepEqual(parsed, parseWorkflowDefinitionOutput(definition));
    assert.throws(
      () => parseWorkflowDefinitionOutput(`\`\`\`json\n${JSON.stringify(definition)}\n\`\`\``),
      /不能包含 Markdown/,
    );

    const preview = previewWorkflowDefinition(definition, 'parallel-readonly');
    assert.equal(preview.schemaVersion, 1);
    assert.equal(preview.budget.nodeCount, 4);
    assert.equal(preview.budget.maxExecutorCalls, 6);
    assert.equal(preview.budget.maxEffectInvocations, 0);
    assert.deepEqual(preview.requirements.permissions, []);
    assert.deepEqual(preview.requirements.repositories, []);
    assert.equal(preview.requirements.writable, false);
    assert.match(preview.previewHash, /^[a-f0-9]{64}$/);
    assert.equal(
      previewWorkflowDefinition(
        JSON.parse(serializeCanonicalJson(definition)),
        'parallel-readonly',
      ).previewHash,
      preview.previewHash,
    );

    const writableDefinition: WorkflowDefinition = {
      id: 'authoring-write-preview',
      limits: {
        maxAgents: 2,
        maxAttemptsPerNode: 1,
        maxConcurrency: 1,
        maxDurationMs: 60_000,
        maxExternalWrites: 1,
        maxIterations: 1,
      },
      nodes: [
        { id: 'prepare', prompt: 'Prepare approval.', type: 'agent' },
        {
          approvalSummary: 'Approve one external write.',
          dependsOn: ['prepare'],
          id: 'approval',
          type: 'checkpoint',
        },
        {
          dependsOn: ['approval'],
          effect: { approvalCheckpoint: 'approval', kind: 'external-write' },
          id: 'write',
          permissions: ['network:connect'],
          prompt: 'Perform the approved external write.',
          requiredCapabilities: ['external-api'],
          type: 'agent',
        },
      ],
      resultNode: 'write',
      schemaVersion: 1,
    };
    assert.throws(
      () => previewWorkflowDefinition(writableDefinition, 'parallel-readonly'),
      /Phase 2 要求 limits.maxExternalWrites 为 0/,
    );
    const writablePreview = previewWorkflowDefinition(
      writableDefinition,
      'writable-worktree',
    );
    assert.equal(writablePreview.requirements.writable, true);
    assert.deepEqual(writablePreview.requirements.permissions, ['network:connect']);
    assert.deepEqual(writablePreview.requirements.requiredCapabilities, ['external-api']);
    assert.deepEqual(writablePreview.checkpoints, [{
      id: 'approval',
      summary: 'Approve one external write.',
    }]);
    assert.deepEqual(writablePreview.effects.map((effect) => ({
      checkpoint: effect.approvalCheckpoint,
      invocations: effect.maxInvocations,
      kind: effect.kind,
      nodeId: effect.nodeId,
    })), [{
      checkpoint: 'approval',
      invocations: 1,
      kind: 'external-write',
      nodeId: 'write',
    }]);

    const builder = new WorkflowDefinitionBuilder('builder-workflow', {
      maxAgents: 1,
      maxAttemptsPerNode: 1,
      maxConcurrency: 1,
      maxDurationMs: 30_000,
      maxExternalWrites: 0,
      maxIterations: 1,
    });
    const built = builder
      .addNode({ id: 'result', prompt: 'Return a result.', type: 'agent' })
      .setResultNode('result')
      .build();
    assert.equal(built.id, 'builder-workflow');
    assert.equal('run' in builder, false);
    assert.equal(previewWorkflowDefinition(built, 'serial').budget.maxExecutorCalls, 1);

    const bundle = createWorkflowDefinitionBundle(definition, {
      previousVersion: {
        definitionHash: 'a'.repeat(64),
        version: 1,
      },
      source: 'model',
      version: 2,
    });
    assert.deepEqual(validateWorkflowDefinitionBundle(bundle), []);
    assert.equal(loadWorkflowDefinitionBundle(serializeCanonicalJson(bundle)).version, 2);
    assert.equal(parseWorkflowDefinitionOutput(bundle).id, definition.id);
    const tamperedBundle = {
      ...bundle,
      definitionHash: 'b'.repeat(64),
    };
    assert.match(validateWorkflowDefinitionBundle(tamperedBundle).join('\n'), /内容哈希一致/);
    assert.match(validateWorkflowDefinitionBundle({
      ...bundle,
      previousVersion: { definitionHash: 'a'.repeat(64), version: 2 },
    }).join('\n'), /必须小于当前 version/);
    const migrated = migrateWorkflowDefinitionArtifact(definition);
    assert.equal(migrated.source, 'migration');
    assert.equal(migrated.version, 1);
    assert.deepEqual(migrateWorkflowDefinitionArtifact(bundle), bundle);

    const approval = approvalFor(preview);
    assert.deepEqual(validateWorkflowExecutionApproval(preview, approval), []);
    assert.match(validateWorkflowExecutionApproval(preview, {
      ...approval,
      extra: true,
    }).join('\n'), /字段必须严格匹配/);
    const permissionChanged: WorkflowDefinition = {
      ...definition,
      nodes: definition.nodes.map((node) => node.id === 'discover'
        ? { ...node, permissions: ['workspace:read'] }
        : node),
    };
    const topologyChanged: WorkflowDefinition = {
      ...definition,
      nodes: definition.nodes.map((node) => node.id === 'security-review'
        ? { ...node, dependsOn: ['correctness-review'] }
        : node),
    };
    assert.match(validateWorkflowExecutionApproval(
      previewWorkflowDefinition(permissionChanged, 'parallel-readonly'),
      approval,
    ).join('\n'), /previewHash/);
    assert.match(validateWorkflowExecutionApproval(
      previewWorkflowDefinition(topologyChanged, 'parallel-readonly'),
      approval,
    ).join('\n'), /previewHash/);
    const executor = new FakeAgentExecutor(fixture);
    const completed = await runApprovedWorkflow({
      approval,
      definition,
      executionMode: 'parallel-readonly',
      executor,
      input: null,
      store: new FileExecutionJournalStore(apiExecutionsRoot, 'run-approved00000001'),
    });
    assert.equal(completed.status, 'completed');

    const changedDefinition: WorkflowDefinition = {
      ...definition,
      limits: {
        ...definition.limits,
        maxDurationMs: definition.limits.maxDurationMs + 1,
      },
    };
    const rejectedStore = new FileExecutionJournalStore(
      apiExecutionsRoot,
      'run-rejected00000001',
    );
    await assert.rejects(
      runApprovedWorkflow({
        approval,
        definition: changedDefinition,
        executionMode: 'parallel-readonly',
        executor: new FakeAgentExecutor(fixture),
        input: null,
        store: rejectedStore,
      }),
      /previewHash 与当前图、预算或权限预览不一致/,
    );
    assert.deepEqual(rejectedStore.readEvents(), []);

    const definitionFile = path.join(temporaryRoot, 'definition.json');
    const fixtureFile = path.join(temporaryRoot, 'fixture.json');
    const savedFile = path.join(temporaryRoot, 'saved.json');
    const migratedFile = path.join(temporaryRoot, 'migrated.json');
    mkdirSync(temporaryRoot, { recursive: true });
    writeFileSync(definitionFile, `${JSON.stringify(definition)}\n`, 'utf8');
    writeFileSync(fixtureFile, `${JSON.stringify(fixture)}\n`, 'utf8');
    const definitionRelative = relativeWorkspacePath(definitionFile);
    const fixtureRelative = relativeWorkspacePath(fixtureFile);
    const previewCli = runCli([
      'execution:author:preview',
      '--file', definitionRelative,
      '--mode', 'parallel-readonly',
      '--format', 'json',
    ]);
    assert.equal(previewCli.status, 0, previewCli.stderr);
    const cliPreview = JSON.parse(previewCli.stdout) as { previewHash: string };
    assert.equal(cliPreview.previewHash, preview.previewHash);
    const saveCli = runCli([
      'execution:author:save',
      '--file', definitionRelative,
      '--output', relativeWorkspacePath(savedFile),
      '--version', '1',
      '--source', 'model',
    ]);
    assert.equal(saveCli.status, 0, saveCli.stderr);
    assert.equal(loadWorkflowDefinitionBundle(
      JSON.parse(readFileSync(savedFile, 'utf8')),
    ).source, 'model');
    const duplicateSaveCli = runCli([
      'execution:author:save',
      '--file', definitionRelative,
      '--output', relativeWorkspacePath(savedFile),
      '--version', '2',
      '--source', 'human',
    ]);
    assert.notEqual(duplicateSaveCli.status, 0);
    assert.match(duplicateSaveCli.stderr, /不允许静默覆盖/);
    assert.equal(loadWorkflowDefinitionBundle(
      JSON.parse(readFileSync(savedFile, 'utf8')),
    ).version, 1);
    const migrateCli = runCli([
      'execution:author:migrate',
      '--file', definitionRelative,
      '--output', relativeWorkspacePath(migratedFile),
    ]);
    assert.equal(migrateCli.status, 0, migrateCli.stderr);
    assert.equal(loadWorkflowDefinitionBundle(
      JSON.parse(readFileSync(migratedFile, 'utf8')),
    ).source, 'migration');
    const runCliResult = runCli([
      'execution:author:run',
      '--file', definitionRelative,
      '--fixture', fixtureRelative,
      '--approval', preview.previewHash,
      '--scheduler', 'parallel',
      '--run-id', cliRunId,
      '--format', 'json',
    ]);
    assert.equal(runCliResult.status, 0, runCliResult.stderr);
    assert.equal((JSON.parse(runCliResult.stdout) as { status: string }).status, 'completed');
    const rejectedCliRunId = `run-${randomBytes(12).toString('hex')}`;
    const rejectedCli = runCli([
      'execution:author:run',
      '--file', definitionRelative,
      '--fixture', fixtureRelative,
      '--approval', '0'.repeat(64),
      '--scheduler', 'parallel',
      '--run-id', rejectedCliRunId,
    ]);
    assert.equal(rejectedCli.status, 1);
    assert.match(rejectedCli.stderr, /--approval 与当前静态预览不一致/);
    assert.equal(existsSync(path.join(
      loadWorkflowPaths().runtimeRoot,
      'executions',
      rejectedCliRunId,
    )), false);

    process.stdout.write(
      '执行内核 Phase 5 回归通过：模型 IR、静态预览、批准绑定、Builder、Bundle 版本/迁移与 CLI 均稳定。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`执行内核 Phase 5 回归失败：${errorMessage(error)}\n`);
    return 1;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
    rmSync(cliRunRoot, { force: true, recursive: true });
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
