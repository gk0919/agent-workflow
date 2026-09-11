import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { loadRoutes } from './context-budget.js';
import { collectRepositories, contentHash } from './task-handoff.js';
import type { RepositorySnapshot } from './task-handoff.js';
import { readTaskFile, replaceFileAtomically } from './task-files.js';
import { readManifestModel, validateManifestTaskFlow } from './task-lifecycle.js';
import { planDefinitionHash } from './task-plan.js';
import { isJsonObject } from '../types/guards.js';
import { assertRealPathWithin } from '../config/workflow-config.js';
import { workflowRoot } from '../config/workspace-paths.js';

export interface TaskCheckpoint {
  schemaVersion: 1;
  taskId: string;
  revision: number;
  savedAt: string;
  reason: string;
  artifacts: Record<string, string>;
  repositories: RepositorySnapshot[];
  route: { id: string; runId: string; version: number; definitionHash: string; reconstructed: boolean };
  approval: { planHash: string; source: string; recordedAt: string } | null;
}

const require = createRequire(import.meta.url);
const Ajv = (require('ajv/dist/2020.js') as { default: typeof Ajv2020 }).default;
const addFormats = (require('ajv-formats') as { default: FormatsPlugin }).default;
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validateCheckpoint = ajv.compile<TaskCheckpoint>(JSON.parse(readFileSync(path.join(workflowRoot, 'resources/schemas/task-checkpoint.schema.json'), 'utf8')));
const DERIVED = new Set(['checkpoint.json', 'handoff.md', 'handoff-state.json']);

export const persistentTask = (directory: string): boolean => readManifestModel(readTaskFile(directory, 'manifest.md')).schemaVersion === 2;

/** Hash the actual task files, including nested evidence; revision archives are immutable history. */
export const taskArtifactHashes = (directory: string): Record<string, string> => {
  const entries: Array<[string, string]> = [];
  const walk = (relative: string): void => {
    const target = path.join(directory, relative);
    assertRealPathWithin(target, directory, relative || 'task');
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && (DERIVED.has(name) || name === 'history')) continue;
      if (/\.(?:lock|tmp)$/.test(name)) continue;
      const file = path.join(directory, name);
      assertRealPathWithin(file, directory, name);
      if (entry.isDirectory()) walk(name);
      else {
        const stats = statSync(file);
        if (!stats.isFile() || stats.size > 4 * 1024 * 1024) throw new Error(`Unbounded task artifact: ${name}`);
        entries.push([name, contentHash(readFileSync(file))]);
      }
      if (entries.length > 1000) throw new Error('Task artifact count exceeds 1000');
    }
  };
  walk('');
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
};

export const readCheckpoint = (directory: string): TaskCheckpoint => {
  const value: unknown = JSON.parse(readTaskFile(directory, 'checkpoint.json'));
  if (!validateCheckpoint(value)) throw new Error(`Invalid checkpoint: ${ajv.errorsText(validateCheckpoint.errors)}`);
  const model = readManifestModel(readTaskFile(directory, 'manifest.md'));
  if (value.taskId !== model.taskId || value.route.id !== model.routeId || value.route.runId !== model.runId) throw new Error('Checkpoint identity mismatch');
  return value;
};

export const routeDefinitionHash = (routeId: string): string => {
  const route = loadRoutes().routes[routeId];
  if (!route?.taskFlow) throw new Error('Persistent route requires taskFlow');
  return contentHash(JSON.stringify({ taskFlow: route.taskFlow, stages: route.stages, taskRequiredStages: route.taskRequiredStages }));
};

export const requirePublishedTask = (directory: string, inspectRepositories = false): TaskCheckpoint | null => {
  if (!persistentTask(directory)) return null;
  const checkpoint = readCheckpoint(directory);
  const actual = taskArtifactHashes(directory);
  const changed = [...new Set([...Object.keys(actual), ...Object.keys(checkpoint.artifacts)])].filter((file) => actual[file] !== checkpoint.artifacts[file]);
  if (changed.length) throw new Error(`Unpublished task changes: ${changed.join(', ')}; inspect then task checkpoint --reconcile --reason <reason>`);
  if (checkpoint.route.definitionHash !== routeDefinitionHash(checkpoint.route.id)) throw new Error('Route definition changed; reconcile the checkpoint after reviewing current gates');
  if (inspectRepositories && JSON.stringify(checkpoint.repositories) !== JSON.stringify(collectRepositories(directory, checkpoint.taskId))) throw new Error('Repository changed since checkpoint; inspect and reconcile before continuing');
  return checkpoint;
};

export const taskPlanHash = (directory: string): string => {
  // Tasks adopted before the Plan stage have no plan.md yet; the projection then
  // covers spec and contract only.
  const plan = existsSync(path.join(directory, 'plan.md')) ? planDefinitionHash(readTaskFile(directory, 'plan.md')) : '';
  const spec = existsSync(path.join(directory, 'spec.md')) ? contentHash(readTaskFile(directory, 'spec.md')) : '';
  const value: unknown = existsSync(path.join(directory, 'verification.json')) ? JSON.parse(readTaskFile(directory, 'verification.json')) : null;
  const contract = isJsonObject(value) ? value : {};
  const tests = Array.isArray(contract.testPoints) ? contract.testPoints.filter(isJsonObject).map(({ status: _s, evidence: _e, blocker: _b, executedAgainst: _x, capability: _c, ...definition }) => definition) : [];
  return contentHash(JSON.stringify({ plan, spec, goals: contract.goals, acceptanceCriteria: contract.acceptanceCriteria, outOfScope: contract.outOfScope, plannedChanges: contract.plannedChanges, tests }));
};

export const hasTaskApproval = (directory: string, checkpoint = readCheckpoint(directory)): boolean => Boolean(checkpoint.approval && checkpoint.approval.planHash === taskPlanHash(directory));

/** Caller owns the manifest lock. The checkpoint is the final publication marker, never a test result. */
export const publishCheckpoint = (directory: string, options: { reason: string; approvalSource?: string; previous?: TaskCheckpoint | null; reconstructed?: boolean }): TaskCheckpoint => {
  if (!options.reason.trim()) throw new Error('Checkpoint reason is required');
  const model = readManifestModel(readTaskFile(directory, 'manifest.md'));
  const errors = validateManifestTaskFlow(model);
  if (errors.length) throw new Error(errors.join('; '));
  const previous = options.previous === undefined && existsSync(path.join(directory, 'checkpoint.json')) ? readCheckpoint(directory) : options.previous ?? null;
  const artifacts = taskArtifactHashes(directory);
  const repositories = collectRepositories(directory, model.taskId);
  const now = new Date().toISOString();
  // An approval without a parsable plan would bind to nothing, so it is not invented.
  const approvedPlanHash = options.approvalSource && existsSync(path.join(directory, 'plan.md')) ? taskPlanHash(directory) : '';
  const checkpoint: TaskCheckpoint = {
    schemaVersion: 1, taskId: model.taskId, revision: (previous?.revision ?? 0) + 1, savedAt: now,
    reason: options.reason, artifacts, repositories,
    route: { id: model.routeId, runId: model.runId, version: loadRoutes().version, definitionHash: routeDefinitionHash(model.routeId), reconstructed: options.reconstructed ?? previous?.route.reconstructed ?? false },
    approval: approvedPlanHash ? { planHash: approvedPlanHash, source: options.approvalSource!, recordedAt: now } : previous?.approval ?? null,
  };
  if (!validateCheckpoint(checkpoint)) throw new Error(ajv.errorsText(validateCheckpoint.errors));
  if (JSON.stringify(artifacts) !== JSON.stringify(taskArtifactHashes(directory)) || JSON.stringify(repositories) !== JSON.stringify(collectRepositories(directory, model.taskId))) throw new Error('Task changed during checkpoint publication');
  const history = path.join(directory, 'history', `revision-${checkpoint.revision}`);
  assertRealPathWithin(history, directory, 'revision archive');
  // A failed publication can leave only a partial archive. The checkpoint is the
  // publication marker, so an unreferenced archive for the next revision is safe
  // to discard and rebuild under the same lock.
  if (existsSync(history)) {
    const publishedRevision = previous?.revision ?? 0;
    if (checkpoint.revision <= publishedRevision) throw new Error('Revision archive is already published; refusing to overwrite history');
    rmSync(history, { recursive: true, force: true });
  }
  mkdirSync(history, { recursive: true });
  for (const [file] of Object.entries(artifacts)) {
    if (!/\.(?:md|json)$/.test(file)) continue;
    const target = path.join(history, file);
    mkdirSync(path.dirname(target), { recursive: true });
    replaceFileAtomically(target, readTaskFile(directory, file));
  }
  replaceFileAtomically(path.join(directory, 'checkpoint.json'), `${JSON.stringify(checkpoint, null, 2)}\n`);
  return checkpoint;
};
