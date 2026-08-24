import fs from 'node:fs';
import path from 'node:path';
import {
  TOOL_TARGET_NAMES,
  TOOL_TARGETS,
  getToolTarget,
} from '../adapters/tool-targets.js';
import {
  loadActiveProfile,
  loadWorkflowConfig,
  loadWorkflowPaths,
  resolveWorkspaceRelativePath,
  workflowConfigPath,
} from '../config/workflow-config.js';
import {
  workflowEntryReference,
  workflowRoot,
  workspaceRoot,
} from '../config/workspace-paths.js';
import { BOOTSTRAP_BLOCK, buildBootstrapBlock } from './bootstrap.js';
import { hasExactManagedBlock, updateManagedBlock } from './managed-block.js';
import { errorMessage } from '../types/guards.js';

const supportedAgents = new Set(['auto', 'all', ...TOOL_TARGET_NAMES]);

const repositoryRoot = workspaceRoot;
const workflowConfig = loadWorkflowConfig();
const activeProfile = loadActiveProfile(workflowConfig);
const workflowPaths = loadWorkflowPaths(workflowConfig);
const startFile = path.join(workflowRoot, 'docs', 'START.md');
const agentsFile = path.join(repositoryRoot, 'AGENTS.md');
const skillsRoot = workflowPaths.skillsRoot;
const qualityScripts = [
  'check-js-diff.js',
  'check-staged.js',
  'check-skills.js',
  'check-workflow-links.js',
  'check-task-artifacts.js',
  'install-git-hooks.js',
  'syntax-check.js',
  'policy-check.js',
].map((fileName) => path.join(workflowRoot, 'dist', 'src', 'validators', fileName));
const managedBlock = buildBootstrapBlock(workflowEntryReference);

interface SetupOptions {
  agents: string[];
  check: boolean;
  dryRun: boolean;
  help: boolean;
}

const options: SetupOptions = {
  agents: [],
  check: false,
  dryRun: false,
  help: false
};

const printUsage = (): void => {
  console.log([
    'Usage:',
    '  agent-workflow setup [options]',
    '',
    'Options:',
    `  --agent <name>   auto, all, ${TOOL_TARGET_NAMES.join(', ')}.`,
    '                   可重复指定。',
    '  --check          检查现有启动文件，不执行写入。',
    '  --dry-run        显示计划修改，不执行写入。',
    '  --help           显示帮助。',
    '',
    'Examples:',
    '  agent-workflow setup --agent auto',
    '  agent-workflow setup --agent all --dry-run',
    '  agent-workflow setup --agent auto --check'
  ].join('\n'));
};

const parseArguments = (args: string[]): void => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--check') {
      options.check = true;
      continue;
    }

    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    if (argument === '--agent') {
      const agent = args[index + 1];
      if (!agent) {
        throw new Error('--agent 需要提供值。');
      }
      options.agents.push(agent);
      index += 1;
      continue;
    }

    if (argument?.startsWith('--agent=')) {
      options.agents.push(argument.slice('--agent='.length));
      continue;
    }

    throw new Error(`未知选项：${argument}`);
  }

  if (options.check && options.dryRun) {
    throw new Error('--check 与 --dry-run 不能同时使用。');
  }

  if (options.agents.length === 0) {
    options.agents.push('auto');
  }

  const invalidAgent = options.agents.find((agent) => !supportedAgents.has(agent));
  if (invalidAgent) {
    throw new Error(`不支持的 Agent：${invalidAgent}`);
  }

  if (options.agents.length > 1 && (options.agents.includes('auto') || options.agents.includes('all'))) {
    throw new Error('auto 或 all 必须单独使用。');
  }
};

const exists = (targetPath: string): boolean => fs.existsSync(targetPath);

const readUtf8 = (targetPath: string): string => fs.readFileSync(targetPath, 'utf8');

const displayPath = (targetPath: string): string =>
  path.relative(repositoryRoot, targetPath).split(path.sep).join('/');

const hasWorkflowReference = (targetPath: string): boolean => {
  if (!exists(targetPath) || !fs.statSync(targetPath).isFile()) {
    return false;
  }

  return hasExactManagedBlock(readUtf8(targetPath), managedBlock, BOOTSTRAP_BLOCK);
};

let missingCount = 0;

const setManagedBridge = (targetPath: string, header = ''): void => {
  const relativePath = displayPath(targetPath);
  if (hasWorkflowReference(targetPath)) {
    console.log(`[ok] ${relativePath} 已接入`);
    return;
  }

  if (options.check) {
    console.log(`[missing] ${relativePath} 尚未接入`);
    missingCount += 1;
    return;
  }

  if (options.dryRun) {
    console.log(`[plan] 接入 ${relativePath}`);
    return;
  }

  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });

  const existingContent = exists(targetPath) ? readUtf8(targetPath) : '';
  let update;
  try {
    update = updateManagedBlock(existingContent, managedBlock, BOOTSTRAP_BLOCK, header);
  } catch (error: unknown) {
    throw new Error(`拒绝更新 ${relativePath} 中格式异常的 managed block：${errorMessage(error)}`);
  }
  fs.writeFileSync(targetPath, update.content, 'utf8');
  console.log(`[updated] ${relativePath} 已接入`);
};

const addDetectedTargets = (targets: Set<string>): void => {
  TOOL_TARGETS
    .filter(({ bootstrap }) => bootstrap === 'shared')
    .forEach(({ name }) => targets.add(name));

  TOOL_TARGETS
    .filter((target) => target.bootstrap === 'managed' &&
      target.detectPaths.some((relativePath) => exists(path.join(repositoryRoot, relativePath))))
    .forEach(({ name }) => targets.add(name));
};

const resolveTargets = (): Set<string> => {
  const targets = new Set<string>();

  if (options.agents.includes('all')) {
    TOOL_TARGET_NAMES.forEach((agent) => targets.add(agent));
    return targets;
  }

  if (options.agents.includes('auto')) {
    addDetectedTargets(targets);
    return targets;
  }

  options.agents.forEach((agent) => targets.add(agent));
  return targets;
};

const checkRequiredFiles = (): void => {
  const requiredFiles: Array<[string, string]> = [
    [workflowConfigPath, '工作流宿主配置'],
    [startFile, '工作流入口'],
    [agentsFile, '仓库指令'],
    [skillsRoot, '中立 Skill 目录'],
    ...activeProfile.setup.requiredPaths.map((relativePath): [string, string] => [
      resolveWorkspaceRelativePath(relativePath, 'setup.requiredPaths'),
      `${activeProfile.id} Profile 必需项`,
    ]),
    ...TOOL_TARGETS.map(({ adapter }): [string, string] => [
      path.join(workflowRoot, adapter),
      '工具 Adapter',
    ]),
    ...qualityScripts.map((filePath): [string, string] => [filePath, '质量检查脚本']),
  ];
  requiredFiles.forEach(([filePath, label]) => {
    if (!exists(filePath)) {
      throw new Error(`缺少${label}：${filePath}`);
    }
  });

  const agentsContent = readUtf8(agentsFile);
  if (agentsContent.includes(workflowEntryReference)) {
    console.log('[ok] AGENTS.md 已指向工作流入口');
    return;
  }

  console.log(`[missing] AGENTS.md 未指向 ${workflowEntryReference}`);
  missingCount += 1;
};

const connectTarget = (target: string): void => {
  const targetConfig = getToolTarget(target);
  if (!targetConfig) {
    throw new Error(`缺少目标配置：${target}`);
  }

  if (targetConfig.bootstrap === 'shared') {
    console.log(`[shared] ${target} 使用根目录 AGENTS.md`);
    return;
  }

  if (targetConfig.bootstrap === 'managed') {
    setManagedBridge(
      path.join(repositoryRoot, targetConfig.bridgePath),
      targetConfig.header,
    );
    return;
  }

  if (targetConfig.bootstrap === 'prompt') {
    console.log(
      `[fallback] Prompt：${targetConfig.manualPrompt.replace('agent-workflow/docs/START.md', workflowEntryReference)}`,
    );
  }
};

const main = (): void => {
  parseArguments(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  checkRequiredFiles();
  const targets = resolveTargets();
  targets.forEach(connectTarget);

  if (options.check) {
    console.log('检查完成；如有 [missing] 项，请运行 agent-workflow setup。');
    if (missingCount > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.dryRun) {
    console.log('试运行完成，未修改任何文件。');
    return;
  }

  console.log('接入完成。打开项目后即可直接提交需求或缺陷。');
};

try {
  main();
}
catch (error: unknown) {
  console.error(`[error] ${errorMessage(error)}`);
  process.exitCode = 1;
}
