import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Ajv2020 } from 'ajv/dist/2020.js';
import { assertRealPathWithin } from '../config/workflow-config.js';
import { workflowRoot, workspaceRoot } from '../config/workspace-paths.js';
import { errorMessage } from '../types/guards.js';
import { readTaskFile } from './task-files.js';
import { parseTaskPlan, validateTaskPlan } from './task-plan.js';
import { validateVerificationContract } from './verification-contract.js';
import { readManifestModel } from './task-lifecycle.js';

export interface BehaviorRequirement {
  id: string;
  statement: string;
  scenarios: Array<{ id: string; given?: string; when: string; then: string }>;
}
export interface CapabilitySpec {
  schemaVersion: 1;
  capability: string;
  status: 'confirmed' | 'observed' | 'unknown';
  evidence: string[];
  requirements: BehaviorRequirement[];
}
export interface SpecChange {
  schemaVersion: 1;
  taskId: string;
  capabilities: Array<{
    id: string;
    baseline: { path: string; hash: string; content: string } | null;
    changes: Array<{
      operation: 'added' | 'modified' | 'removed';
      requirementId: string;
      requirement?: BehaviorRequirement;
      reason: string;
      acceptanceIds: string[];
      verificationIds: string[];
    }>;
  }>;
}
export interface ArtifactReadiness {
  id: string;
  dependsOn: string[];
  status: 'ready' | 'blocked';
  issues: string[];
}
export interface SpecImpact {
  capability: string;
  requirementId: string;
  operation: string;
  reason: string;
  before: BehaviorRequirement | null;
  after: BehaviorRequirement | null;
  acceptanceIds: string[];
  verificationIds: string[];
}
export interface SpecInspection {
  enabled: boolean;
  specChangeHash?: string;
  errors: string[];
  artifacts: ArtifactReadiness[];
  impacts: SpecImpact[];
}

const require = createRequire(import.meta.url);
const Ajv = (require('ajv/dist/2020.js') as { default: typeof Ajv2020 }).default;
const ajv = new Ajv({ allErrors: true, strict: true });
const schema = (name: string): object => JSON.parse(readFileSync(path.join(workflowRoot, 'resources/schemas', name), 'utf8')) as object;
const baselineSchema = schema('capability-spec.schema.json');
const validateBaseline = ajv.compile<CapabilitySpec>(baselineSchema);
const validateDelta = ajv.compile<SpecChange>(schema('spec-change.schema.json'));
export const specContentHash = (content: string): string => createHash('sha256').update(content).digest('hex');

/** Baseline locators are workspace relative and cannot escape through junctions or symlinks. */
const baselinePath = (relative: string, root: string): string => {
  if (!relative || relative.includes('\\') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      relative.split('/').some(part => !part || part === '..')) throw new Error('Expected workspace-relative baseline path with / separators');
  const resolved = path.resolve(root, relative);
  const location = path.relative(root, resolved);
  if (location === '..' || location.startsWith(`..${path.sep}`) || path.isAbsolute(location)) throw new Error('Baseline path escapes workspace');
  return resolved;
};

export const readSpecBaseline = (relative: string, root = workspaceRoot): string => {
  const file = baselinePath(relative, root);
  assertRealPathWithin(file, root, 'capability baseline');
  const stats = statSync(file);
  if (!stats.isFile() || stats.size > 128 * 1024) throw new Error('Capability baseline exceeds 128 KiB or is not a file');
  return readFileSync(file, 'utf8');
};

/** Evidence records provenance; confirmed is a human-reviewed claim, not an automatic proof. */
export const parseCapabilitySpec = (content: string): CapabilitySpec => {
  const value: unknown = JSON.parse(content);
  if (!validateBaseline(value)) throw new Error(`Invalid capability baseline: ${ajv.errorsText(validateBaseline.errors)}`);
  const ids = new Set<string>();
  for (const requirement of value.requirements) {
    if (ids.has(requirement.id)) throw new Error(`Duplicate requirement: ${requirement.id}`);
    ids.add(requirement.id);
    assertScenarioIds(requirement);
  }
  return value;
};

const assertScenarioIds = (requirement: BehaviorRequirement): void => {
  if (new Set(requirement.scenarios.map(scenario => scenario.id)).size !== requirement.scenarios.length) {
    throw new Error(`Duplicate scenario in ${requirement.id}`);
  }
};

/** Compute readiness from actual artifacts; callers never accept model-supplied ready flags. */
export const inspectSpecChange = (directory: string, options: { root?: string; checkSources?: boolean; content?: string } = {}): SpecInspection => {
  const report: SpecInspection = { enabled: options.content !== undefined || existsSync(path.join(directory, 'spec-change.json')), errors: [], artifacts: [], impacts: [] };
  if (!report.enabled) return report;
  try {
    const content = options.content ?? readTaskFile(directory, 'spec-change.json');
    report.specChangeHash = specContentHash(content);
    const value: unknown = JSON.parse(content);
    if (!validateDelta(value)) throw new Error(`Invalid spec-change.json: ${ajv.errorsText(validateDelta.errors)}`);
    if (value.taskId !== path.basename(directory)) throw new Error('spec-change taskId does not match task directory');
    const node = (id: string, dependsOn: string[], issues: string[]): void => {
      const blocked = dependsOn.filter(dependency => report.artifacts.find(artifact => artifact.id === dependency)?.status !== 'ready');
      const all = [...issues, ...blocked.map(dependency => `Dependency blocked: ${dependency}`)];
      report.artifacts.push({ id, dependsOn, status: all.length ? 'blocked' : 'ready', issues: all });
    };
    const capabilityIds = new Set<string>();
    const deltaIssues: string[] = [];
    for (const capability of value.capabilities) {
      if (capabilityIds.has(capability.id)) throw new Error(`Duplicate capability: ${capability.id}`);
      capabilityIds.add(capability.id);
      const baseline = capability.baseline;
      let previous: CapabilitySpec | null = null;
      const issues: string[] = [];
      if (baseline) {
        if (specContentHash(baseline.content) !== baseline.hash) throw new Error(`Snapshot hash mismatch: ${capability.id}`);
        previous = parseCapabilitySpec(baseline.content);
        if (previous.capability !== capability.id) throw new Error(`Baseline capability mismatch: ${capability.id}`);
        // Always validate the locator, even when historical inspection does not require a live source.
        baselinePath(baseline.path, options.root ?? workspaceRoot);
        if (previous.status !== 'confirmed') issues.push(`Baseline is ${previous.status}; human confirmation required`);
        if (options.checkSources !== false) {
          try {
            if (specContentHash(readSpecBaseline(baseline.path, options.root)) !== baseline.hash) issues.push(`Baseline changed: ${baseline.path}; review and recapture before approval`);
          } catch (error) { issues.push(errorMessage(error)); }
        }
      }
      node(`baseline:${capability.id}`, [], issues);
      const old = new Map((previous?.requirements ?? []).map(requirement => [requirement.id, requirement]));
      const changed = new Set<string>();
      if (!capability.changes.length) deltaIssues.push(`No changes declared: ${capability.id}`);
      for (const change of capability.changes) {
        if (changed.has(change.requirementId)) throw new Error(`Duplicate change: ${capability.id}/${change.requirementId}`);
        changed.add(change.requirementId);
        const before = old.get(change.requirementId) ?? null;
        if (change.operation === 'added' ? before !== null : before === null) throw new Error(`Invalid ${change.operation} target: ${capability.id}/${change.requirementId}`);
        const after = change.requirement ?? null;
        if (change.operation === 'removed') {
          if (after) throw new Error('Removed requirement must not contain a replacement');
        } else {
          if (!after || after.id !== change.requirementId) throw new Error('Added/modified requirement must contain the complete matching replacement');
          assertScenarioIds(after);
          if (JSON.stringify(before) === JSON.stringify(after)) throw new Error(`Modified requirement has no change: ${change.requirementId}`);
        }
        report.impacts.push({ capability: capability.id, requirementId: change.requirementId, operation: change.operation,
          reason: change.reason, before, after, acceptanceIds: change.acceptanceIds, verificationIds: change.verificationIds });
      }
    }
    node('delta', value.capabilities.map(capability => `baseline:${capability.id}`), deltaIssues);
    const spec = existsSync(path.join(directory, 'spec.md')) ? readTaskFile(directory, 'spec.md') : '';
    node('spec', ['delta'], spec.trim() ? [] : ['Missing spec.md behavior and design rationale']);
    let contract: unknown;
    const verificationIssues: string[] = [];
    if (!existsSync(path.join(directory, 'verification.json'))) verificationIssues.push('Missing verification.json');
    else {
      contract = JSON.parse(readTaskFile(directory, 'verification.json'));
      verificationIssues.push(...validateVerificationContract(contract, { expectedTaskId: value.taskId }));
      if (!verificationIssues.length) {
        const binding = contract as { schemaVersion: number; specChangeHash?: string };
        if (binding.schemaVersion !== 2 || binding.specChangeHash !== report.specChangeHash) {
          verificationIssues.push('verification.json must use schemaVersion 2 and bind specChangeHash to the current spec-change.json bytes');
        }
        const typed = contract as { acceptanceCriteria: Array<{ id: string }>; testPoints: Array<{ id: string; acceptanceIds: string[] }> };
        for (const impact of report.impacts) {
          for (const id of impact.acceptanceIds) {
            if (!typed.acceptanceCriteria.some(ac => ac.id === id)) verificationIssues.push(`Unknown AC: ${id}`);
            if (!impact.verificationIds.some(vt => typed.testPoints.some(point => point.id === vt && point.acceptanceIds.includes(id)))) verificationIssues.push(`Changed requirement ${impact.capability}/${impact.requirementId} lacks VT coverage for ${id}`);
          }
          for (const id of impact.verificationIds) if (!typed.testPoints.some(point => point.id === id)) verificationIssues.push(`Unknown VT: ${id}`);
        }
      }
    }
    node('verification', ['spec'], verificationIssues);
    const planIssues: string[] = [];
    if (!existsSync(path.join(directory, 'plan.md'))) planIssues.push('Missing plan.md');
    else {
      try {
        const plan = parseTaskPlan(readTaskFile(directory, 'plan.md'), value.taskId);
        const stages = readManifestModel(readTaskFile(directory, 'manifest.md')).stages.map(stage => stage.name);
        planIssues.push(...validateTaskPlan(plan, { contract, stages }));
        if (!verificationIssues.length) {
          const changes = (contract as { plannedChanges: Array<{ id: string; acceptanceIds: string[] }> }).plannedChanges;
          const items = plan.items.filter(item => !item.deferred);
          for (const impact of report.impacts) {
            for (const id of impact.verificationIds) if (!items.some(item => item.verificationIds.includes(id))) planIssues.push(`Plan has no work item for ${id}`);
            for (const change of changes.filter(change => change.acceptanceIds.some(id => impact.acceptanceIds.includes(id)))) {
              if (!items.some(item => item.plannedChangeIds.includes(change.id))) planIssues.push(`Plan has no work item for ${change.id}`);
            }
          }
        }
      }
      catch (error) { planIssues.push(errorMessage(error)); }
    }
    node('plan', ['verification'], planIssues);
  } catch (error) { report.errors.push(errorMessage(error)); }
  return report;
};

/** New contracts gate only opted-in tasks; completed history uses captured bytes, not a mutable registry. */
export const specChangeGateErrors = (directory: string, stages: Array<{ name: string; status: string }>, options: { root?: string; checkSources?: boolean } = {}): string[] => {
  return specReadinessErrors(inspectSpecChange(directory, options), stages);
};

/** Share the same computed result between status projection and transition admission. */
export const specReadinessErrors = (report: SpecInspection, stages: Array<{ name: string; status: string }>): string[] => {
  const required = stages.some(stage => stage.name === 'Plan' && stage.status === 'complete') ? 'plan'
    : stages.some(stage => stage.name === 'Spec' && stage.status === 'complete') ? 'verification' : null;
  if (!report.enabled) return [];
  return [...report.errors, ...(required ? report.artifacts.filter(artifact => artifact.status === 'blocked' && (required === 'plan' || artifact.id !== 'plan')).flatMap(artifact => artifact.issues.map(issue => `${artifact.id}: ${issue}`)) : [])];
};
