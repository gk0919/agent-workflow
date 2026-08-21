import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { buildIssueTrackingRule } from '../../src/validators/check-commit-message.js';
import {
  loadActiveProfile,
  loadWorkflowConfig,
  loadWorkflowProfile,
  resolveWorkspaceRelativePath,
  validateWorkflowConfig,
  validateWorkflowProfile,
} from '../../src/config/workflow-config.js';
import { classifyRouteFacts } from '../../src/core/classify-route.js';
import { buildRoutePacket, loadRoutes } from '../../src/core/context-budget.js';
import { errorMessage } from '../../src/types/guards.js';

/** Covers Profile replacement, path containment and legacy route compatibility. */
export const main = (): number => {
  try {
    const config = loadWorkflowConfig();
    const profile = loadActiveProfile(config);
    const defaultProfile = loadWorkflowProfile(
      'workflow:resources/profiles/default/profile.json',
    );
    assert.ok(profile.id);
    assert.equal(defaultProfile.id, 'default');
    assert.deepEqual(validateWorkflowConfig(config), []);
    assert.deepEqual(validateWorkflowProfile(profile), []);
    assert.deepEqual(validateWorkflowProfile(defaultProfile), []);
    const activeIssueRule = buildIssueTrackingRule(profile);
    assert.equal(activeIssueRule.enabled, profile.issueTracking.enabled);
    assert.equal(
      activeIssueRule.expression instanceof RegExp,
      profile.issueTracking.enabled,
    );
    assert.equal(buildIssueTrackingRule(defaultProfile).enabled, false);
    assert.throws(
      () => resolveWorkspaceRelativePath('../outside.json'),
      /不能越出工作区/,
    );
    const unsafeConfig = structuredClone(config);
    unsafeConfig.paths.tasksRoot = '.';
    assert.ok(
      validateWorkflowConfig(unsafeConfig)
        .some((message) => message.includes('不能指向工作区根目录')),
    );
    const unsafeProfile = structuredClone(defaultProfile);
    unsafeProfile.governance.markdownRoots = ['../outside'];
    assert.ok(
      validateWorkflowProfile(unsafeProfile)
        .some((message) => message.includes('不能越出工作区')),
    );

    const portableProfile = structuredClone(profile);
    portableProfile.id = 'portable-test';
    portableProfile.taskModel.intentRoutes.evolutionary = null;
    portableProfile.taskModel.changeIntents = ['change', 'defect', 'evolutionary'];
    portableProfile.taskModel.changeTypes = ['defect', 'evolutionary'];
    portableProfile.taskModel.changeTypeByIntent = {
      defect: 'defect',
      evolutionary: 'evolutionary',
    };
    portableProfile.taskModel.evolutionaryChangeTypes = ['evolutionary'];
    portableProfile.taskModel.microStages = {
      defect: 'locate-defect',
      evolutionary: 'locate-requirement',
    };
    assert.deepEqual(validateWorkflowProfile(portableProfile), []);
    const classification = classifyRouteFacts({
      acceptanceClear: true,
      behaviorClear: true,
      compatibilityClear: true,
      entry: 'direct',
      files: 1,
      goalClear: true,
      hasValidationPath: true,
      intent: 'evolutionary',
      noNewBusinessState: true,
      repositories: 1,
      semanticLines: 2,
      uniqueLocation: true,
      usesExistingPattern: true,
    }, loadRoutes(), portableProfile);
    assert.equal(classification.changeType, 'evolutionary');
    assert.equal(classification.route, 'micro-change');
    assert.equal(classification.stage, 'locate-requirement');

    const previousOverride = process.env.AI_WORKFLOW_PROFILE;
    try {
      process.env.AI_WORKFLOW_PROFILE = 'workflow:resources/profiles/default/profile.json';
      const packet = buildRoutePacket({
        entry: 'direct',
        route: 'analysis',
        stage: 'capture',
      });
      assert.equal(packet.profile.id, 'default');
      assert.equal(packet.profile.sourceProvider, 'conversation');
    } finally {
      if (previousOverride === undefined) {
        delete process.env.AI_WORKFLOW_PROFILE;
      } else {
        process.env.AI_WORKFLOW_PROFILE = previousOverride;
      }
    }

    process.stdout.write(
      'Workflow Profile 回归通过：配置、路径边界、默认 Profile 和可替换任务词汇正常。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`Workflow Profile 回归失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
