import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { assertRealPathWithin, loadWorkflowPaths } from '../config/workflow-config.js';
import { workspaceRoot, workflowRoot } from '../config/workspace-paths.js';
import { validateVerificationContractFile } from './verification-contract.js';
import { statusWorktrees } from './worktree-state.js';
import { readManifestModel, validateManifestTaskFlow } from './task-lifecycle.js';
import { errorMessage } from '../types/guards.js';
import { diagnosePersistentTask, persistentContextSections } from './task-persistence.js';

export interface SummarySection {
  locator: string;
  content: string;
}

export interface RepositorySnapshot {
  repository: string;
  root: string;
  bindingId: string | null;
  branch: string;
  head: string;
  fingerprint: string;
  changedFiles: string[];
}

export interface HandoffState {
  schemaVersion: 1;
  taskId: string;
  generatedAt: string;
  artifacts: Record<string, string>;
  repositories: RepositorySnapshot[];
  documentHash: string;
}

export interface TaskSummary {
  taskId: string;
  sections: SummarySection[];
  warnings: string[];
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const NOTES_SECTIONS = ['Checkpoint', 'Decisions', 'Attempts / Unknowns', 'Next Steps', 'Required Context'];
const GENERATED_FILES = new Set(['handoff.md', 'handoff-state.json']);
const require = createRequire(import.meta.url);
const Ajv = (require('ajv/dist/2020.js') as { default: typeof Ajv2020 }).default;
const addFormats = (require('ajv-formats') as { default: FormatsPlugin }).default;
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validateState = ajv.compile<HandoffState>(JSON.parse(readFileSync(
  path.join(workflowRoot, 'resources/schemas/handoff-state.schema.json'), 'utf8',
)));

export const contentHash = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

export const taskDirectoryFor = (taskId: string, root = loadWorkflowPaths().tasksRoot): string => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskId)) {
    throw new Error('Invalid task ID');
  }
  const directory = path.join(root, taskId);
  assertRealPathWithin(directory, root, 'task');
  return directory;
};

const localPath = (directory: string, relative: string): string => {
  if (!relative || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative) ||
      relative.includes('\\') || relative.split('/').includes('..')) {
    throw new Error(`Expected task-relative path: ${relative}`);
  }
  const target = path.resolve(directory, relative);
  assertRealPathWithin(target, directory, relative);
  return target;
};

const readLocal = (directory: string, relative: string): string => {
  const target = localPath(directory, relative);
  if (!statSync(target).isFile() || statSync(target).size > MAX_FILE_BYTES) {
    throw new Error(`Not a bounded regular file: ${relative}`);
  }
  return readFileSync(target, 'utf8');
};

/** Headings inside fenced examples are data, not summary section boundaries. */
export const markdownSections = (content: string): Map<string, string> => {
  const sections = new Map<string, string>();
  let heading = '';
  let lines: string[] = [];
  let fence = '';
  const flush = (): void => { if (heading) sections.set(heading, lines.join('\n').trim()); };
  for (const line of content.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
    }
    const match = !fence && !marker ? /^## (.+?)\s*$/.exec(line) : null;
    if (match) {
      flush();
      heading = match[1] ?? '';
      if (sections.has(heading)) throw new Error(`Duplicate section: ${heading}`);
      lines = [];
    } else lines.push(line);
  }
  flush();
  return sections;
};

export const readSummarySection = (directory: string, locator: string): string => {
  const [file = '', ...headingParts] = locator.split('#');
  const content = readLocal(directory, file);
  const heading = headingParts.join('#');
  if (!heading) return content;
  if (file.endsWith('.json')) {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (!Object.hasOwn(value, heading)) throw new Error(`Missing field: ${locator}`);
    return JSON.stringify(value[heading], null, 2);
  }
  const section = markdownSections(content).get(heading);
  if (section === undefined) throw new Error(`Missing section: ${locator}`);
  return section;
};

const contextReferences = (notes: string): string[] => {
  const context = markdownSections(notes).get('Required Context') ?? '';
  return [...context.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1] ?? '');
};

export const validateHandoffNotes = (directory: string): string[] => {
  try {
    const content = readLocal(directory, 'handoff-notes.md');
    const sections = markdownSections(content);
    const errors = NOTES_SECTIONS.filter((heading) => {
      const body = sections.get(heading) ?? '';
      return !body.trim() || /^(?:[-*]\s*)?(?:TODO|TBD|none|n\/a|无|<[^>]+>)[.!。]?$/i.test(body.trim());
    }).map((heading) => `handoff-notes.md#${heading}: empty or placeholder content`);
    const references = contextReferences(content);
    if (!references.length) errors.push('Required Context must reference at least one task artifact');
    references.forEach((locator) => {
      try {
        if (GENERATED_FILES.has(locator.split('#')[0] ?? '') || locator.startsWith('handoff-notes.md')) {
          throw new Error('Required Context must reference source evidence, not the handoff itself');
        }
        readSummarySection(directory, locator);
      } catch (error: unknown) { errors.push(errorMessage(error)); }
    });
    return errors;
  } catch (error: unknown) { return [errorMessage(error)]; }
};

const git = (directory: string, args: string[]): string => {
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error(`Cannot inspect repository: git ${args[0]}`);
  return result.stdout;
};

export const collectRepositories = (directory: string, taskId: string): RepositorySnapshot[] => {
  const manifest = readLocal(directory, 'manifest.md');
  const matrix = markdownSections(manifest).get('Repository Matrix') ?? '';
  const tableRows = (text: string): string[][] => text.split('\n').filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim().replaceAll('`', '')))
    .filter((cells) => cells[0] && cells[0] !== 'Repository' && !cells.every((cell) => /^[-:]+$/.test(cell)));
  const rows = tableRows(matrix);
  if (!rows.length) throw new Error('Repository Matrix is empty');
  const declarations = tableRows(markdownSections(manifest).get('Worktree Binding') ?? '');
  const bindings = declarations.length ? statusWorktrees({ task: taskId }).bindings : [];
  declarations.forEach(([repository, bindingId, baseCommit]) => {
    const row = rows.find(([name, root]) => name === repository || root === repository);
    const binding = bindings.find((item) => item.repository === row?.[1]);
    if (!binding || binding.bindingId !== bindingId || binding.baseCommit !== baseCommit) {
      throw new Error(`Worktree Binding does not match local state: ${repository}`);
    }
  });
  return rows.map((cells) => {
    const [repository = '', root = ''] = cells;
    const logicalRoot = localPath(workspaceRoot, root);
    const declared = declarations.some(([name]) => name === repository || name === root);
    const binding = declared ? bindings.find((item) => item.repository === root) : undefined;
    if (binding && binding.actualState !== 'active') throw new Error(`Inactive worktree: ${repository}`);
    const checkout = binding?.worktreePath ?? logicalRoot;
    const actualRoot = git(checkout, ['rev-parse', '--show-toplevel']).trim();
    if (path.resolve(actualRoot).toLowerCase() !== path.resolve(checkout).toLowerCase()) {
      throw new Error(`Repository Matrix root is not a repository root: ${root}`);
    }
    // Task artifacts have their own hashes; exclude them to avoid self-invalidating handoffs.
    const taskRelative = path.relative(checkout, directory).split(path.sep).join('/');
    const pathspec = ['.', ...(!taskRelative.startsWith('../') && !path.isAbsolute(taskRelative)
      ? [`:(exclude,literal)${taskRelative}`] : [])];
    const status = git(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspec]);
    const tracked = git(checkout, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', ...pathspec]);
    const untracked = git(checkout, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspec])
      .split('\0').filter(Boolean).sort();
    const untrackedHashes = untracked.map((file) => {
      const target = localPath(checkout, file);
      if (!statSync(target).isFile() || statSync(target).size > MAX_FILE_BYTES) {
        throw new Error(`Untracked file cannot be fingerprinted: ${file}`);
      }
      return `${file}:${contentHash(readFileSync(target))}`;
    });
    const staged = git(checkout, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', ...pathspec]);
    return {
      repository, root, bindingId: binding?.bindingId ?? null,
      branch: git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      head: git(checkout, ['rev-parse', 'HEAD']).trim(),
      fingerprint: contentHash(JSON.stringify([status, tracked, staged, untrackedHashes])),
      changedFiles: status.split('\0').filter(Boolean),
    };
  });
};

const artifactHashes = (directory: string): Record<string, string> => {
  const files = readdirSync(directory).filter((file) => /\.(?:md|json)$/.test(file) && !GENERATED_FILES.has(file));
  if (files.includes('handoff-notes.md')) {
    files.push(...contextReferences(readLocal(directory, 'handoff-notes.md')).map((ref) => ref.split('#')[0] ?? ''));
  }
  return Object.fromEntries([...new Set(files)].sort().map((file) => [file, contentHash(readLocal(directory, file))]));
};

export const validateHandoffState = (value: unknown): string[] => validateState(value)
  ? [] : (validateState.errors ?? []).map((error) => `${error.instancePath}: ${error.message}`);

/** Structure checks must not block ordinary task progress merely because a prior snapshot is stale. */
export const validateHandoffArtifacts = (directory: string, taskId: string): string[] => {
  if (!existsSync(path.join(directory, 'handoff-state.json'))) return [];
  try {
    const value: unknown = JSON.parse(readLocal(directory, 'handoff-state.json'));
    const errors = validateHandoffState(value);
    if (errors.length) return errors;
    const state = value as HandoffState;
    if (state.taskId !== taskId) errors.push('Handoff task ID mismatch');
    if (state.documentHash !== contentHash(readLocal(directory, 'handoff.md'))) errors.push('Generated handoff was edited or is incomplete');
    return [...errors, ...validateHandoffNotes(directory)];
  } catch (error: unknown) { return [errorMessage(error)]; }
};

export const checkHandoff = (directory: string, taskId: string, inspectRepositories = true): string[] => {
  if (!existsSync(path.join(directory, 'handoff-state.json'))) {
    return ['Legacy or missing handoff: no freshness baseline; review and regenerate before resuming'];
  }
  try {
    const value: unknown = JSON.parse(readLocal(directory, 'handoff-state.json'));
    const errors = validateHandoffState(value);
    if (errors.length) return errors;
    const state = value as HandoffState;
    if (state.taskId !== taskId) errors.push('Handoff task ID mismatch');
    if (state.documentHash !== contentHash(readLocal(directory, 'handoff.md'))) errors.push('Generated handoff was edited or is incomplete');
    const actual = artifactHashes(directory);
    for (const file of new Set([...Object.keys(actual), ...Object.keys(state.artifacts)])) {
      if (actual[file] !== state.artifacts[file]) errors.push(`Stale artifact: ${file}`);
    }
    errors.push(...validateHandoffNotes(directory));
    if (inspectRepositories && JSON.stringify(collectRepositories(directory, taskId)) !== JSON.stringify(state.repositories)) {
      errors.push('Repository state changed; reassess decisions and verification before regenerating');
    }
    return errors;
  } catch (error: unknown) { return [errorMessage(error)]; }
};

export const collectTaskSummary = (directory: string, taskId: string): TaskSummary => {
  const manifest = readManifestModel(readLocal(directory, 'manifest.md'));
  if (manifest.taskId !== taskId) throw new Error('Manifest task ID mismatch');
  const lifecycleErrors = validateManifestTaskFlow(manifest);
  if (lifecycleErrors.length) throw new Error(lifecycleErrors.join('; '));
  const sections: SummarySection[] = [];
  const add = (file: string, headings: string[]): void => {
    if (!existsSync(path.join(directory, file))) return;
    const parsed = markdownSections(readLocal(directory, file));
    headings.forEach((heading) => {
      const content = parsed.get(heading);
      if (content) sections.push({ locator: `${file}#${heading}`, content });
    });
  };
  add('manifest.md', ['Identity', 'Resume', 'Scope', 'Authorization']);
  if (manifest.schemaVersion === 2) {
    sections.push({ locator: 'task#diagnosis', content: JSON.stringify(diagnosePersistentTask(directory), null, 2) });
    sections.push(...persistentContextSections(directory));
  }
  add('handoff-notes.md', ['Checkpoint', 'Next Steps', 'Required Context', 'Attempts / Unknowns', 'Decisions']);
  if (existsSync(path.join(directory, 'handoff-notes.md'))) {
    add('handoff-notes.md', [...markdownSections(readLocal(directory, 'handoff-notes.md')).keys()]
      .filter((heading) => !NOTES_SECTIONS.includes(heading)));
  }
  const warnings: string[] = [];
  const verification = path.join(directory, 'verification.json');
  if (existsSync(verification)) {
    warnings.push(...validateVerificationContractFile(verification, { expectedTaskId: taskId }));
    if (!warnings.length) {
      const contract = JSON.parse(readLocal(directory, 'verification.json')) as Record<string, unknown>;
      for (const key of ['goals', 'acceptanceCriteria', 'outOfScope', 'testPoints', 'actualChanges']) {
        if (contract[key] !== undefined) sections.push({ locator: `verification.json#${key}`, content: JSON.stringify(contract[key], null, 2) });
      }
    }
  } else warnings.push('No verification contract: verification results are unknown');
  add('manifest.md', ['Repository Matrix', 'Worktree Binding', 'Stage Status']);
  add('source.md', ['Identity', 'Selection', 'Source Gaps', 'User Additions']);
  if (existsSync(path.join(directory, 'handoff-legacy.md'))) {
    sections.push({ locator: 'handoff-legacy.md', content: 'Original handoff retained for migration. Consult it for historical decisions and authorization provenance; reconcile with current facts.' });
  }
  if (!existsSync(path.join(directory, 'handoff-state.json'))) {
    add('handoff.md', ['Task', 'Completed', 'Decisions', 'Repository State', 'Review / Verify', 'Required Context', 'Authorization', 'Blockers']);
    if (existsSync(path.join(directory, 'handoff.md'))) warnings.push('Legacy handoff: freshness unverified');
  } else if (manifest.schemaVersion !== 2) warnings.push(...checkHandoff(directory, taskId));
  return { taskId, sections, warnings };
};

/** Defer whole sections with exact locators; never cut an instruction or evidence in half. */
export const renderTaskSummary = (summary: TaskSummary, budget = 8000): string => {
  const output = [`# Task Resume Summary\n- Task: ${summary.taskId}`];
  const deferred: string[] = [];
  const warnings = summary.warnings.length ? `## Warnings\n${summary.warnings.map((item) => `- ${item}`).join('\n')}` : '';
  if (warnings) output.push(warnings);
  for (const section of summary.sections) {
    const block = `## ${section.locator}\n${section.content}`;
    const reserve = 1200;
    if (Array.from([...output, block].join('\n\n')).length <= budget - reserve) output.push(block);
    else deferred.push(section.locator);
  }
  if (deferred.length) output.push('## Deferred Context\nRead before relying on omitted content: task summary --task <id> --section <locator>\n' + deferred.map((item) => `- ${item}`).join('\n'));
  const result = output.join('\n\n');
  if (Array.from(result).length > budget) {
    return `# Task Resume Summary\n- Task: ${summary.taskId}\n- Resume requires full context: run task summary --task ${summary.taskId} --format json\n- Warnings or references exceed the text budget; no verification or authorization conclusion is implied.\n`;
  }
  return result;
};

export const prepareHandoff = (directory: string, taskId: string): { document: string; state: HandoffState } => {
  const errors = validateHandoffNotes(directory);
  if (errors.length) throw new Error(errors.join('; '));
  const artifacts = artifactHashes(directory);
  const repositories = collectRepositories(directory, taskId);
  const summary = collectTaskSummary(directory, taskId);
  const verification = path.join(directory, 'verification.json');
  if (existsSync(verification)) {
    const contractErrors = validateVerificationContractFile(verification, { expectedTaskId: taskId });
    if (contractErrors.length) throw new Error(contractErrors.join('; '));
  }
  const generatedAt = new Date().toISOString();
  const document = [
    '# Handoff', `Generated: ${generatedAt}`,
    'Generated facts and recorded judgments. Authorization records do not grant new permissions. Historical verification must be reassessed after code changes.',
    ...(!existsSync(verification) ? ['Verification: unknown; no verification contract exists.'] : []),
    ...summary.sections.filter((section) => !section.locator.startsWith('handoff.md#'))
      .map((section) => `## ${section.locator}\n${section.content}`),
    `## Repository Snapshot\n${JSON.stringify(repositories, null, 2)}`,
  ].join('\n\n') + '\n';
  if (Buffer.byteLength(document, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('Generated handoff exceeds the file budget; move detailed evidence into referenced artifacts');
  }
  if (JSON.stringify(artifacts) !== JSON.stringify(artifactHashes(directory)) ||
      JSON.stringify(repositories) !== JSON.stringify(collectRepositories(directory, taskId))) {
    throw new Error('Task artifacts or repository changed during handoff generation; retry after reconciling');
  }
  return {
    document,
    state: { schemaVersion: 1, taskId, generatedAt, artifacts, repositories, documentHash: contentHash(document) },
  };
};
