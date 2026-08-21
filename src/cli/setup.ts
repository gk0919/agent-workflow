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
    '                   May be repeated.',
    '  --check          Check existing bootstrap files without writing.',
    '  --dry-run        Show planned changes without writing.',
    '  --help           Show this help.',
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
        throw new Error('--agent requires a value.');
      }
      options.agents.push(agent);
      index += 1;
      continue;
    }

    if (argument?.startsWith('--agent=')) {
      options.agents.push(argument.slice('--agent='.length));
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  if (options.check && options.dryRun) {
    throw new Error('--check and --dry-run cannot be used together.');
  }

  if (options.agents.length === 0) {
    options.agents.push('auto');
  }

  const invalidAgent = options.agents.find((agent) => !supportedAgents.has(agent));
  if (invalidAgent) {
    throw new Error(`Unsupported agent: ${invalidAgent}`);
  }

  if (options.agents.length > 1 && (options.agents.includes('auto') || options.agents.includes('all'))) {
    throw new Error('Use auto or all by itself.');
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
    console.log(`[ok] ${relativePath} is connected`);
    return;
  }

  if (options.check) {
    console.log(`[missing] ${relativePath} is not connected`);
    missingCount += 1;
    return;
  }

  if (options.dryRun) {
    console.log(`[plan] connect ${relativePath}`);
    return;
  }

  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });

  const existingContent = exists(targetPath) ? readUtf8(targetPath) : '';
  let update;
  try {
    update = updateManagedBlock(existingContent, managedBlock, BOOTSTRAP_BLOCK, header);
  } catch (error: unknown) {
    throw new Error(`Refusing to update malformed managed block in ${relativePath}: ${errorMessage(error)}`);
  }
  fs.writeFileSync(targetPath, update.content, 'utf8');
  console.log(`[updated] ${relativePath} is connected`);
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
    [workflowConfigPath, 'workflow host configuration'],
    [startFile, 'workflow entry'],
    [agentsFile, 'repository instructions'],
    [skillsRoot, 'neutral skill directory'],
    ...activeProfile.setup.requiredPaths.map((relativePath): [string, string] => [
      resolveWorkspaceRelativePath(relativePath, 'setup.requiredPaths'),
      `${activeProfile.id} profile requirement`,
    ]),
    ...TOOL_TARGETS.map(({ adapter }): [string, string] => [
      path.join(workflowRoot, adapter),
      'tool adapter',
    ]),
    ...qualityScripts.map((filePath): [string, string] => [filePath, 'quality script']),
  ];
  requiredFiles.forEach(([filePath, label]) => {
    if (!exists(filePath)) {
      throw new Error(`Missing ${label}: ${filePath}`);
    }
  });

  const agentsContent = readUtf8(agentsFile);
  if (agentsContent.includes(workflowEntryReference)) {
    console.log('[ok] AGENTS.md points to the workflow entry');
    return;
  }

  console.log(`[missing] AGENTS.md does not point to ${workflowEntryReference}`);
  missingCount += 1;
};

const connectTarget = (target: string): void => {
  const targetConfig = getToolTarget(target);
  if (!targetConfig) {
    throw new Error(`Missing target configuration: ${target}`);
  }

  if (targetConfig.bootstrap === 'shared') {
    console.log(`[shared] ${target} uses the root AGENTS.md`);
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
      `[fallback] Prompt: ${targetConfig.manualPrompt.replace('agent-workflow/docs/START.md', workflowEntryReference)}`,
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
    console.log('Check complete. Run agent-workflow setup when a [missing] entry is reported.');
    if (missingCount > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.dryRun) {
    console.log('Dry run complete. No files were changed.');
    return;
  }

  console.log('Setup complete. Open the project and submit a request or defect directly.');
};

try {
  main();
}
catch (error: unknown) {
  console.error(`[error] ${errorMessage(error)}`);
  process.exitCode = 1;
}
