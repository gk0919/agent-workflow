import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  workflowRoot,
  workspaceRoot as repositoryRoot,
} from '../config/workspace-paths.js';
import { errorMessage } from '../types/guards.js';

const hooksDirectory = path.join(repositoryRoot, '.githooks');
const hookTemplatesDirectory = path.join(workflowRoot, 'resources', 'hooks');
const hookNames = ['pre-commit', 'commit-msg'];
const managedHookMarker = 'agent-workflow:managed-hook';

const runGit = (
  args: string[],
  workingDirectory: string,
): SpawnSyncReturns<string> => spawnSync('git', args, {
  cwd: workingDirectory,
  encoding: 'utf8',
  windowsHide: true,
});

const normalizePath = (filePath: string): string => filePath.split(path.sep).join('/');

const hookTemplatePath = (hookName: string): string => path.join(hookTemplatesDirectory, hookName);
const installedHookPath = (hookName: string): string => path.join(hooksDirectory, hookName);
const normalizeHookContent = (content: string): string =>
  `${content.replaceAll('\r\n', '\n').replace(/\n*$/, '')}\n`;

const hooksInSync = (): boolean => hookNames.every((hookName) => {
  const templatePath = hookTemplatePath(hookName);
  const targetPath = installedHookPath(hookName);
  return existsSync(templatePath) &&
    existsSync(targetPath) &&
    normalizeHookContent(readFileSync(templatePath, 'utf8')) ===
      normalizeHookContent(readFileSync(targetPath, 'utf8'));
});

const parseArguments = (args: string[]): { check: boolean; repository: string } => {
  let repository = repositoryRoot;
  let check = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--repository') {
      const repositoryArgument = args[index + 1];
      if (!repositoryArgument) {
        throw new Error('--repository requires a value.');
      }
      repository = path.resolve(repositoryRoot, repositoryArgument);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { check, repository };
};

const readConfiguredHooksPath = (targetRoot: string): string => {
  const result = runGit(['config', '--local', '--get', 'core.hooksPath'], targetRoot);
  if (result.status === 1) {
    return '';
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || '无法读取 core.hooksPath');
  }
  return normalizePath(result.stdout.trim());
};

const resolveRepository = (requestedRepository: string): string => {
  const result = runGit(['rev-parse', '--show-toplevel'], requestedRepository);
  if (result.status !== 0) {
    throw new Error(`目标路径不是 Git 仓库：${requestedRepository}`);
  }

  const actualRoot = path.resolve(result.stdout.trim());
  const relativeRoot = path.relative(repositoryRoot, actualRoot);
  if (relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) {
    throw new Error(`目标仓库不在当前工作区内：${actualRoot}`);
  }
  hookNames.forEach((hookName) => {
    if (!existsSync(hookTemplatePath(hookName))) {
      throw new Error(`工作流包缺少 Hook 模板：${hookName}`);
    }
  });
  return actualRoot;
};

const expectedHooksPath = (targetRoot: string): string =>
  normalizePath(path.relative(targetRoot, hooksDirectory) || '.');

const checkHooks = (targetRoot: string): number => {
  const configuredHooksPath = readConfiguredHooksPath(targetRoot);
  const expectedPath = expectedHooksPath(targetRoot);
  if (configuredHooksPath !== expectedPath) {
    process.stderr.write(
      `Git Hook 未接入：core.hooksPath=${configuredHooksPath || '未设置'}，期望 ${expectedPath}\n`,
    );
    return 1;
  }
  if (!hooksInSync()) {
    process.stderr.write('Git Hook 内容与当前工作流包版本不一致，请重新运行安装命令。\n');
    return 1;
  }

  process.stdout.write(`Git Hook 已接入：${targetRoot} -> ${expectedPath}\n`);
  return 0;
};

const installHooks = (targetRoot: string): number => {
  mkdirSync(hooksDirectory, { recursive: true });
  hookNames.forEach((hookName) => {
    const targetPath = installedHookPath(hookName);
    if (existsSync(targetPath)) {
      const existingContent = readFileSync(targetPath, 'utf8');
      const isLegacyWorkflowHook = existingContent.includes('.ai-workflow');
      if (!existingContent.includes(managedHookMarker) && !isLegacyWorkflowHook) {
        throw new Error(`拒绝覆盖非工作流管理的 Hook：${targetPath}`);
      }
    }
    copyFileSync(hookTemplatePath(hookName), targetPath);
    chmodSync(targetPath, 0o755);
  });

  const expectedPath = expectedHooksPath(targetRoot);
  const result = runGit(['config', '--local', 'core.hooksPath', expectedPath], targetRoot);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || '无法设置 core.hooksPath');
  }
  process.stdout.write(`Git Hook 已配置：${targetRoot} -> ${expectedPath}\n`);
  return 0;
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  const options = parseArguments(args);
  const targetRoot = resolveRepository(options.repository);
  return options.check ? checkHooks(targetRoot) : installHooks(targetRoot);
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    process.exitCode = main();
  } catch (error: unknown) {
    process.stderr.write(`Git Hook 配置失败：${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
