import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOOTSTRAP_BLOCK, buildBootstrapBlock } from './bootstrap.js';
import {
  hasExactManagedBlock,
  updateManagedBlock,
  type ManagedBlockDefinition,
} from './managed-block.js';
import { errorMessage, isJsonObject } from '../types/guards.js';

interface InitOptions {
  check: boolean;
  dryRun: boolean;
  help: boolean;
  profileId: string;
}

interface PackageMetadata {
  name?: string;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const packageMetadata = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
) as { name: string };
const repositoryRoot = path.resolve(process.cwd());
const hostPackagePath = path.join(repositoryRoot, 'package.json');
const workflowProjectRoot = path.join(repositoryRoot, '.agent-workflow');
const profileRoot = path.join(workflowProjectRoot, 'profile');

export const HOST_PACKAGE_SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  'quality:all': 'agent-workflow quality:all',
  'quality:hooks:check': 'agent-workflow quality:hooks --check',
  'quality:hooks:setup': 'agent-workflow quality:hooks',
  'quality:js': 'agent-workflow quality:js',
  'quality:policy': 'agent-workflow quality:policy',
  'quality:skills': 'agent-workflow quality:skills',
  'quality:staged': 'agent-workflow quality:staged',
  'quality:tasks': 'agent-workflow quality:tasks',
  'quality:workflow': 'agent-workflow quality:workflow',
  'workflow:classify': 'agent-workflow classify',
  'workflow:context': 'agent-workflow context',
  'workflow:feedback': 'agent-workflow feedback',
  'workflow:init': 'agent-workflow init',
  'workflow:init:check': 'agent-workflow init --check',
  'workflow:knowledge': 'agent-workflow knowledge',
  'workflow:next': 'agent-workflow next',
  'workflow:profile': 'agent-workflow profile --check',
  'workflow:retention': 'agent-workflow retention',
  'workflow:route': 'agent-workflow route',
  'workflow:setup': 'agent-workflow setup --agent auto',
  'workflow:setup:check': 'agent-workflow setup --agent auto --check',
  'workflow:task': 'agent-workflow task',
  'workflow:verify:ci': 'agent-workflow verify:ci',
  'workflow:verify:contract': 'agent-workflow verify:contract',
  'workflow:worktree': 'agent-workflow worktree',
});

const GITIGNORE_BLOCK: ManagedBlockDefinition = Object.freeze({
  end: '# ai-workflow:local-state:end',
  start: '# ai-workflow:local-state:start',
});

const printUsage = (): void => {
  process.stdout.write([
    'Usage:',
    '  agent-workflow init [options]',
    '',
    'Options:',
    '  --profile-id <id>  Project Profile id (default: derived from package name).',
    '  --check            Check initialized files without writing.',
    '  --dry-run          Show planned changes without writing.',
    '  --help             Show this help.',
    '',
  ].join('\n'));
};

const profileIdFromPackageName = (name: unknown): string => {
  const unscoped = typeof name === 'string' ? (name.split('/').pop() ?? '') : '';
  const normalized = unscoped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'project';
};

const parseArguments = (args: string[], packageName: unknown): InitOptions => {
  const options: InitOptions = {
    check: false,
    dryRun: false,
    help: false,
    profileId: profileIdFromPackageName(packageName),
  };
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
    if (argument === '--profile-id') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--profile-id requires a value.');
      }
      options.profileId = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--profile-id=')) {
      options.profileId = argument.slice('--profile-id='.length);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (options.check && options.dryRun) {
    throw new Error('--check and --dry-run cannot be used together.');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.profileId)) {
    throw new Error('--profile-id must contain lowercase letters, numbers and hyphens only.');
  }
  return options;
};

const toPosixRelative = (fromPath: string, targetPath: string): string =>
  path.relative(fromPath, targetPath).split(path.sep).join('/');

const dependencyRoot = path.join(
  repositoryRoot,
  'node_modules',
  ...packageMetadata.name.split('/'),
);
const workflowReferenceRoot = fs.existsSync(dependencyRoot) ? dependencyRoot : packageRoot;
const workflowEntryReference = toPosixRelative(
  repositoryRoot,
  path.join(workflowReferenceRoot, 'docs', 'START.md'),
);

let failureCount = 0;

const reportMissing = (relativePath: string): void => {
  process.stdout.write(`[missing] ${relativePath}\n`);
  failureCount += 1;
};

const ensureDirectory = (relativePath: string, options: InitOptions): void => {
  const targetPath = path.join(repositoryRoot, relativePath);
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
    process.stdout.write(`[ok] ${relativePath}/\n`);
    return;
  }
  if (options.check) {
    reportMissing(`${relativePath}/`);
  } else if (options.dryRun) {
    process.stdout.write(`[plan] create ${relativePath}/\n`);
  } else {
    fs.mkdirSync(targetPath, { recursive: true });
    process.stdout.write(`[created] ${relativePath}/\n`);
  }
};

const ensureFile = (
  relativePath: string,
  content: string,
  options: InitOptions,
): void => {
  const targetPath = path.join(repositoryRoot, relativePath);
  if (fs.existsSync(targetPath)) {
    if (!fs.statSync(targetPath).isFile()) {
      throw new Error(`${relativePath} exists but is not a file.`);
    }
    process.stdout.write(`[kept] ${relativePath}\n`);
    return;
  }
  if (options.check) {
    reportMissing(relativePath);
  } else if (options.dryRun) {
    process.stdout.write(`[plan] create ${relativePath}\n`);
  } else {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
    process.stdout.write(`[created] ${relativePath}\n`);
  }
};

const ensureManagedFile = (
  relativePath: string,
  managedBlock: string,
  definition: ManagedBlockDefinition,
  options: InitOptions,
): void => {
  const targetPath = path.join(repositoryRoot, relativePath);
  const existingContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
  if (hasExactManagedBlock(existingContent, managedBlock, definition)) {
    process.stdout.write(`[ok] ${relativePath}\n`);
    return;
  }
  if (options.check) {
    reportMissing(`${relativePath} managed block`);
    return;
  }
  if (options.dryRun) {
    process.stdout.write(`[plan] update ${relativePath}\n`);
    return;
  }
  let update;
  try {
    update = updateManagedBlock(existingContent, managedBlock, definition);
  } catch (error: unknown) {
    throw new Error(`${relativePath}: ${errorMessage(error)}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, update.content, 'utf8');
  process.stdout.write(`[updated] ${relativePath}\n`);
};

const ensurePackageScripts = (
  packageContent: string,
  packageJson: PackageMetadata,
  options: InitOptions,
): void => {
  if (packageJson.scripts !== undefined && !isJsonObject(packageJson.scripts)) {
    throw new Error('package.json scripts must be an object.');
  }
  const scriptEntries = Object.entries(packageJson.scripts ?? {});
  if (scriptEntries.some(([, command]) => typeof command !== 'string')) {
    throw new Error('package.json scripts values must be strings.');
  }
  const scripts = Object.fromEntries(scriptEntries) as Record<string, string>;
  const conflicts = Object.entries(HOST_PACKAGE_SCRIPTS)
    .filter(([name, command]) => scripts[name] !== undefined && scripts[name] !== command);
  if (conflicts.length > 0) {
    conflicts.forEach(([name, command]) =>
      process.stderr.write(`[conflict] package.json scripts.${name} must be ${JSON.stringify(command)}\n`));
    throw new Error('Resolve conflicting workflow package scripts before running init again.');
  }
  const missing = Object.entries(HOST_PACKAGE_SCRIPTS)
    .filter(([name]) => scripts[name] === undefined);
  if (missing.length === 0) {
    process.stdout.write('[ok] package.json workflow scripts\n');
    return;
  }
  if (options.check) {
    reportMissing(`package.json scripts: ${missing.map(([name]) => name).join(', ')}`);
    return;
  }
  if (options.dryRun) {
    process.stdout.write(`[plan] add ${missing.length} package.json workflow scripts\n`);
    return;
  }
  const indentation = packageContent.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  const lineEnding = packageContent.includes('\r\n') ? '\r\n' : '\n';
  packageJson.scripts = { ...scripts, ...Object.fromEntries(missing) };
  const serialized = `${JSON.stringify(packageJson, null, indentation)}\n`.replaceAll('\n', lineEnding);
  fs.writeFileSync(hostPackagePath, serialized, 'utf8');
  process.stdout.write(`[updated] package.json added ${missing.length} workflow scripts\n`);
};

const buildConfig = (): string => `${JSON.stringify({
  $schema: toPosixRelative(
    workflowProjectRoot,
    path.join(workflowReferenceRoot, 'resources', 'schemas', 'workflow-config.schema.json'),
  ),
  schemaVersion: 1,
  activeProfile: '.agent-workflow/profile/profile.json',
  plugins: [],
  paths: {
    knowledgeRoot: '.agent-workflow/profile/knowledge',
    skillsRoot: '.agents/skills',
    tasksRoot: '.agent-workflow/tasks/local',
    runtimeRoot: '.agent-workflow/runtime',
  },
}, null, 2)}\n`;

const buildProfile = (profileId: string): string => `${JSON.stringify({
  $schema: toPosixRelative(
    profileRoot,
    path.join(workflowReferenceRoot, 'resources', 'schemas', 'workflow-profile.schema.json'),
  ),
  schemaVersion: 1,
  extends: 'workflow:resources/profiles/default/profile.json',
  id: profileId,
  description: `Project-specific workflow bindings for ${profileId}.`,
  governance: {
    markdownFiles: ['AGENTS.md', '.agent-workflow/profile/policy.md'],
  },
  setup: {
    requiredPaths: ['.agent-workflow/profile/policy.md'],
  },
}, null, 2)}\n`;

const assertFileTarget = (relativePath: string): void => {
  const targetPath = path.join(repositoryRoot, relativePath);
  if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isFile()) {
    throw new Error(`${relativePath} exists but is not a file.`);
  }
};

const assertDirectoryTarget = (relativePath: string): void => {
  const targetPath = path.join(repositoryRoot, relativePath);
  if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) {
    throw new Error(`${relativePath} exists but is not a directory.`);
  }
};

const assertManagedTarget = (
  relativePath: string,
  managedBlock: string,
  definition: ManagedBlockDefinition,
): void => {
  assertFileTarget(relativePath);
  const targetPath = path.join(repositoryRoot, relativePath);
  const existingContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
  try {
    updateManagedBlock(existingContent, managedBlock, definition);
  } catch (error: unknown) {
    throw new Error(`${relativePath}: ${errorMessage(error)}`);
  }
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  if (!fs.existsSync(hostPackagePath)) {
    throw new Error(`package.json not found in ${repositoryRoot}`);
  }
  const packageContent = fs.readFileSync(hostPackagePath, 'utf8');
  const parsedPackage: unknown = JSON.parse(packageContent);
  if (!isJsonObject(parsedPackage)) {
    throw new Error('package.json must contain an object.');
  }
  const hostPackage = parsedPackage as PackageMetadata;
  const options = parseArguments(args, hostPackage.name);
  if (options.help) {
    printUsage();
    return 0;
  }

  failureCount = 0;
  const bootstrapBlock = buildBootstrapBlock(workflowEntryReference);
  const gitignoreBlock = [
    GITIGNORE_BLOCK.start,
    '.agent-workflow/runtime/*',
    '!.agent-workflow/runtime/README.md',
    '.agent-workflow/tasks/local/',
    '.worktrees/',
    GITIGNORE_BLOCK.end,
  ].join('\n');
  [
    '.agent-workflow/profile/knowledge',
    '.agent-workflow/runtime',
    '.agent-workflow/tasks/local',
    '.agents/skills',
  ].forEach(assertDirectoryTarget);
  [
    '.agent-workflow/config.json',
    '.agent-workflow/profile/profile.json',
    '.agent-workflow/profile/policy.md',
    '.agent-workflow/profile/knowledge/README.md',
    '.agent-workflow/runtime/README.md',
    '.agents/skills/.gitkeep',
  ].forEach(assertFileTarget);
  assertManagedTarget('AGENTS.md', bootstrapBlock, BOOTSTRAP_BLOCK);
  assertManagedTarget('.gitignore', gitignoreBlock, GITIGNORE_BLOCK);

  ensurePackageScripts(packageContent, hostPackage, options);
  ensureDirectory('.agent-workflow/profile/knowledge', options);
  ensureDirectory('.agent-workflow/runtime', options);
  ensureDirectory('.agent-workflow/tasks/local', options);
  ensureDirectory('.agents/skills', options);
  ensureFile('.agent-workflow/config.json', buildConfig(), options);
  ensureFile('.agent-workflow/profile/profile.json', buildProfile(options.profileId), options);
  ensureFile(
    '.agent-workflow/profile/policy.md',
    '# Project Workflow Policy\n\nDocument project-specific workflow facts and reference them from AGENTS.md or a selected Skill.\n',
    options,
  );
  ensureFile(
    '.agent-workflow/profile/knowledge/README.md',
    '# Project Knowledge\n\nReusable project knowledge is staged and approved here; runtime logs and credentials are never stored here.\n',
    options,
  );
  ensureFile(
    '.agent-workflow/runtime/README.md',
    '# Runtime\n\nThis directory stores anonymous workflow events and temporary state. Only this README is committed.\n',
    options,
  );
  ensureFile('.agents/skills/.gitkeep', '', options);

  ensureManagedFile(
    'AGENTS.md',
    bootstrapBlock,
    BOOTSTRAP_BLOCK,
    options,
  );
  ensureManagedFile('.gitignore', gitignoreBlock, GITIGNORE_BLOCK, options);

  if (options.check && failureCount > 0) {
    process.stderr.write(`Initialization check failed: ${failureCount} missing item(s).\n`);
    return 1;
  }
  if (options.dryRun) {
    process.stdout.write('Init dry run complete. No files were changed.\n');
  } else if (options.check) {
    process.stdout.write('Initialization check passed.\n');
  } else {
    process.stdout.write('Initialization complete. Run npm run workflow:setup next.\n');
  }
  return 0;
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    process.exitCode = main();
  } catch (error: unknown) {
    process.stderr.write(`[error] ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
