#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface CommandTarget {
  prefixArguments: string[];
  script: string;
}

interface PackageMetadata {
  version: string;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageMetadata = JSON.parse(
  readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
) as PackageMetadata;

const command = (script: string, prefixArguments: string[] = []): CommandTarget => ({
  prefixArguments,
  script,
});
const COMMANDS: Readonly<Record<string, CommandTarget>> = Object.freeze({
  'cli:test': command('dist/tests/contract/cli-regression.js'),
  'execution:plan': command('dist/src/core/execution-plan.js'),
  'execution:author:migrate': command('dist/src/execution/authoring-cli.js', ['migrate']),
  'execution:author:preview': command('dist/src/execution/authoring-cli.js', ['preview']),
  'execution:author:run': command('dist/src/execution/cli.js', ['approved-run']),
  'execution:author:save': command('dist/src/execution/authoring-cli.js', ['save']),
  'execution:author:test': command('dist/tests/contract/workflow-authoring-regression.js'),
  'execution:run': command('dist/src/execution/cli.js', ['run']),
  'execution:resume': command('dist/src/execution/cli.js', ['resume']),
  'execution:pause': command('dist/src/execution/cli.js', ['pause']),
  'execution:cancel': command('dist/src/execution/cli.js', ['cancel']),
  'execution:parallel:run': command('dist/src/execution/cli.js', ['run', '--scheduler', 'parallel']),
  'execution:parallel:resume': command('dist/src/execution/cli.js', ['resume', '--scheduler', 'parallel']),
  'execution:parallel:test': command('dist/tests/contract/parallel-runner-regression.js'),
  'execution:portability:test': command('dist/tests/contract/executor-portability-regression.js'),
  'execution:writable:test': command('dist/tests/contract/writable-workspace-regression.js'),
  'execution:runner:test': command('dist/tests/contract/serial-runner-regression.js'),
  'execution:test': command('dist/tests/contract/execution-plan-regression.js'),
  init: command('dist/src/cli/init.js'),
  'init:test': command('dist/tests/contract/init-regression.js'),
  setup: command('dist/src/cli/setup.js'),
  profile: command('dist/src/core/profile.js'),
  'profile:test': command('dist/tests/contract/profile-regression.js'),
  'plugins:check': command('dist/src/host-node/cli.js'),
  'plugins:test': command('dist/tests/contract/plugin-regression.js'),
  'source:capture': command('dist/src/host-node/source-capture-cli.js'),
  classify: command('dist/src/core/classify-route.js'),
  route: command('dist/src/core/route.js'),
  next: command('dist/src/core/workflow-next.js'),
  context: command('dist/src/core/context-check.js'),
  'verify:ci': command('dist/src/core/ci-verification.js'),
  'verify:ci:test': command('dist/tests/contract/ci-verification-regression.js'),
  'verify:contract': command('dist/src/core/verification-contract.js'),
  'routes:docs': command('dist/src/core/render-routes.js'),
  'routes:eval': command('dist/src/core/route-eval.js'),
  'routes:prompt-eval': command('dist/src/core/fact-extraction-eval.js'),
  'routes:test': command('dist/tests/contract/route-regression.js'),
  security: command('dist/src/core/security-policy.js'),
  'security:test': command('dist/tests/contract/security-policy-regression.js'),
  feedback: command('dist/src/core/runtime-log.js'),
  event: command('dist/src/core/runtime-log.js', ['record']),
  retention: command('dist/src/core/retention-report.js'),
  knowledge: command('dist/src/core/knowledge-state.js'),
  task: command('dist/src/core/task-state.js'),
  'task:test': command('dist/tests/contract/task-state-regression.js'),
  worktree: command('dist/src/core/worktree-state.js'),
  'worktree:test': command('dist/tests/contract/worktree-state-regression.js'),
  'quality:js': command('dist/src/validators/check-js-diff.js'),
  'quality:js-comments:test': command('dist/tests/contract/check-js-diff-regression.js'),
  'quality:staged': command('dist/src/validators/check-staged.js'),
  'quality:skills': command('dist/src/validators/check-skills.js'),
  'quality:workflow': command('dist/src/validators/check-workflow-links.js'),
  'quality:tasks': command('dist/src/validators/check-task-artifacts.js'),
  'quality:hooks': command('dist/src/validators/install-git-hooks.js'),
  'quality:syntax': command('dist/src/validators/syntax-check.js'),
  'quality:policy': command('dist/src/validators/policy-check.js'),
  'quality:all': command('dist/src/validators/policy-check.js', ['--staged']),
  'quality:commit-message': command('dist/src/validators/check-commit-message.js'),
});

const printUsage = (): void => {
  process.stdout.write([
    'Usage: agent-workflow <command> [arguments]',
    '',
    'Commands:',
    ...Object.keys(COMMANDS).sort().map((name) => `  ${name}`),
    '',
  ].join('\n'));
};

const runWithPlugins = async (
  commandName: string,
  runCommand: () => number,
): Promise<number> => {
  const { loadWorkflowConfig } = await import('../src/config/workflow-config.js');
  const { workspaceRoot } = await import('../src/config/workspace-paths.js');
  const { createNodePluginHost } = await import('../src/host-node/index.js');
  const host = await createNodePluginHost(loadWorkflowConfig(), { workspaceRoot });
  await host.start();
  let exitCode = 1;
  try {
    await host.emit('command:before', Object.freeze({ command: commandName }));
    exitCode = runCommand();
    await host.emit('command:after', Object.freeze({ command: commandName, exitCode }));
    return exitCode;
  } finally {
    await host.stop();
  }
};

const main = async (): Promise<number> => {
  const [commandName, ...argumentsList] = process.argv.slice(2);
  if (!commandName || commandName === '--help' || commandName === '-h') {
    printUsage();
    return 0;
  }
  if (commandName === '--version' || commandName === '-v') {
    process.stdout.write(`${packageMetadata.version}\n`);
    return 0;
  }

  const target = COMMANDS[commandName];
  if (!target) {
    process.stderr.write(`未知命令：${commandName}\n`);
    printUsage();
    return 1;
  }

  const runCommand = (): number => {
    const result = spawnSync(
      process.execPath,
      [path.join(packageRoot, target.script), ...target.prefixArguments, ...argumentsList],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    if (result.error) {
      process.stderr.write(`命令启动失败：${result.error.message}\n`);
      return 1;
    }
    return result.status ?? 1;
  };

  // Init precedes workspace configuration; setup and plugin checks own their lifecycle.
  // Execution commands own their explicit executor lifecycle and never activate ambient plugins.
  if (commandName === 'init' || commandName === 'setup' || commandName === 'source:capture' ||
      commandName.startsWith('execution:') || commandName.startsWith('plugins:')) {
    return runCommand();
  }
  try {
    return await runWithPlugins(commandName, runCommand);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`插件宿主执行失败：${message}\n`);
    return 1;
  }
};

process.exitCode = await main();
