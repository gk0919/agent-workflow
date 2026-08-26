import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { workflowRoot } from '../config/workspace-paths.js';

interface PolicyStep {
  argumentsList: string[];
  script: string;
}

const step = (script: string, argumentsList: string[] = []): PolicyStep => ({
  argumentsList,
  script,
});
const POLICY_STEPS = Object.freeze([
  step('dist/src/validators/syntax-check.js'),
  step('dist/tests/contract/cli-regression.js'),
  step('dist/tests/contract/execution-plan-regression.js'),
  step('dist/tests/contract/serial-runner-regression.js'),
  step('dist/tests/contract/parallel-runner-regression.js'),
  step('dist/tests/contract/executor-portability-regression.js'),
  step('dist/tests/contract/writable-workspace-regression.js'),
  step('dist/tests/contract/workflow-authoring-regression.js'),
  step('dist/tests/contract/init-regression.js'),
  step('dist/src/core/profile.js', ['--check']),
  step('dist/tests/contract/profile-regression.js'),
  step('dist/src/host-node/cli.js'),
  step('dist/tests/contract/plugin-regression.js'),
  step('dist/tests/contract/mcp-source-provider-regression.js'),
  step('dist/src/validators/check-skills.js'),
  step('dist/src/validators/check-workflow-links.js'),
  step('dist/tests/contract/check-js-diff-regression.js'),
  step('dist/src/core/security-policy.js', ['--check']),
  step('dist/tests/contract/security-policy-regression.js'),
  step('dist/src/core/context-check.js'),
  step('dist/src/core/render-routes.js', ['--check']),
  step('dist/tests/contract/route-regression.js'),
  step('dist/src/core/route-eval.js'),
  step('dist/src/core/fact-extraction-eval.js', ['--check-suite']),
  step('dist/tests/contract/runtime-regression.js'),
  step('dist/tests/contract/task-state-regression.js'),
  step('dist/tests/contract/worktree-state-regression.js'),
  step('dist/src/core/retention-report.js', ['--check']),
  step('dist/src/core/ci-verification.js', ['--all']),
  step('dist/tests/contract/ci-verification-regression.js'),
  step('dist/src/core/verification-contract.js', ['--all']),
  step('dist/src/validators/check-task-artifacts.js'),
]);

const runStep = ({ script, argumentsList }: PolicyStep) => spawnSync(
  process.execPath,
  [path.join(workflowRoot, script), ...argumentsList],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  },
);

export const main = (args = process.argv.slice(2)): number => {
  const steps = args.includes('--staged')
    ? [step('dist/src/validators/check-staged.js'), ...POLICY_STEPS]
    : POLICY_STEPS;

  for (const policyStep of steps) {
    const result = runStep(policyStep);
    if (result.error) {
      process.stderr.write(`策略门禁启动失败：${result.error.message}\n`);
      return 1;
    }
    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }
  process.stdout.write('工作流策略门禁通过。\n');
  return 0;
};

process.exitCode = main();
