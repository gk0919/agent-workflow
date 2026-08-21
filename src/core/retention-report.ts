import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadWorkflowPaths } from '../config/workflow-config.js';
import { workflowRoot } from '../config/workspace-paths.js';
import { workspaceRoot } from './context-budget.js';
import { readManifestModel } from './task-lifecycle.js';
import { errorMessage } from '../types/guards.js';

interface RetentionPolicy {
  completedConversationTaskDays: number;
  completedPortableTaskDays: number;
  knowledgeStagingDays: number;
  maxReportItems: number;
  mode: string;
  runtimeLogsDays: number;
  staleOpenTaskDays: number;
  version: number;
  [key: string]: number | string;
}

interface RetentionCandidate {
  ageDays: number;
  kind: string;
  path: string;
}

interface RetentionReport {
  candidates: RetentionCandidate[];
  omitted: number;
  total: number;
}

const policyPath = path.join(
  workflowRoot,
  'resources',
  'policies',
  'retention-policy.json',
);
const workflowPaths = loadWorkflowPaths();
const tasksRoot = workflowPaths.tasksRoot;
const logsRoot = path.join(workflowPaths.runtimeRoot, 'logs');
const stagingRoot = path.join(workflowPaths.knowledgeRoot, '_staging');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Loads the package-owned, report-only retention policy. */
export const loadRetentionPolicy = (): RetentionPolicy =>
  JSON.parse(readFileSync(policyPath, 'utf8')) as RetentionPolicy;

export const validateRetentionPolicy = (
  policy: RetentionPolicy = loadRetentionPolicy(),
): string[] => {
  const errors: string[] = [];
  if (policy.version !== 1) {
    errors.push('retention-policy version 必须为 1');
  }
  if (policy.mode !== 'report-only') {
    errors.push('retention-policy mode 必须为 report-only');
  }
  const positiveIntegerFields: Array<
    'staleOpenTaskDays' |
    'runtimeLogsDays' |
    'completedConversationTaskDays' |
    'completedPortableTaskDays' |
    'knowledgeStagingDays' |
    'maxReportItems'
  > = [
    'staleOpenTaskDays',
    'runtimeLogsDays',
    'completedConversationTaskDays',
    'completedPortableTaskDays',
    'knowledgeStagingDays',
    'maxReportItems',
  ];
  positiveIntegerFields.forEach((name) => {
    if (!Number.isInteger(policy[name]) || policy[name] <= 0) {
      errors.push(`${name} 必须是正整数`);
    }
  });
  return errors;
};

const ageDays = (timestamp: number, now: number): number =>
  Math.floor((now - timestamp) / DAY_MS);

const displayPath = (filePath: string): string =>
  path.relative(workspaceRoot, filePath).split(path.sep).join('/');

const listTaskCandidates = (
  policy: RetentionPolicy,
  now: number,
): RetentionCandidate[] => {
  if (!existsSync(tasksRoot)) {
    return [];
  }
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      const manifestPath = path.join(tasksRoot, name, 'manifest.md');
      if (!existsSync(manifestPath)) {
        return [];
      }
      try {
        const model = readManifestModel(readFileSync(manifestPath, 'utf8'));
        const updatedAt = Date.parse(model.lastUpdated);
        if (Number.isNaN(updatedAt)) {
          return [{
            ageDays: 0,
            kind: 'invalid-task-timestamp',
            path: displayPath(manifestPath),
          }];
        }
        const age = ageDays(updatedAt, now);
        if (model.status !== 'complete' && age >= policy.staleOpenTaskDays) {
          return [{
            ageDays: age,
            kind: 'stale-open-task',
            path: displayPath(manifestPath),
          }];
        }
        if (model.status !== 'complete') {
          return [];
        }
        const threshold = model.stateMode === 'Portable'
          ? policy.completedPortableTaskDays
          : policy.completedConversationTaskDays;
        return age >= threshold
          ? [{
            ageDays: age,
            kind: 'completed-task-archive-candidate',
            path: displayPath(manifestPath),
          }]
          : [];
      } catch {
        return [{
          ageDays: 0,
          kind: 'invalid-task-manifest',
          path: displayPath(manifestPath),
        }];
      }
    });
};

const listLogCandidates = (
  policy: RetentionPolicy,
  now: number,
): RetentionCandidate[] => {
  if (!existsSync(logsRoot)) {
    return [];
  }
  return readdirSync(logsRoot)
    .filter((fileName) =>
      /^(?:route|workflow)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName))
    .flatMap((fileName) => {
      const date = fileName.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      const timestamp = Date.parse(`${date}T00:00:00Z`);
      const age = ageDays(timestamp, now);
      return age >= policy.runtimeLogsDays
        ? [{
          ageDays: age,
          kind: 'runtime-log-expired',
          path: displayPath(path.join(logsRoot, fileName)),
        }]
        : [];
    });
};

const listStagingCandidates = (
  policy: RetentionPolicy,
  now: number,
): RetentionCandidate[] => {
  if (!existsSync(stagingRoot)) {
    return [];
  }
  return readdirSync(stagingRoot)
    .filter((fileName) => fileName.endsWith('.md'))
    .flatMap((fileName) => {
      const filePath = path.join(stagingRoot, fileName);
      const age = ageDays(statSync(filePath).mtimeMs, now);
      return age >= policy.knowledgeStagingDays
        ? [{
          ageDays: age,
          kind: 'knowledge-staging-review',
          path: displayPath(filePath),
        }]
        : [];
    });
};

export const buildRetentionReport = ({
  now = Date.now(),
  policy = loadRetentionPolicy(),
}: { now?: number; policy?: RetentionPolicy } = {}): RetentionReport => {
  const errors = validateRetentionPolicy(policy);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }
  const candidates = [
    ...listTaskCandidates(policy, now),
    ...listLogCandidates(policy, now),
    ...listStagingCandidates(policy, now),
  ].sort((left, right) =>
    right.ageDays - left.ageDays || left.path.localeCompare(right.path));
  return {
    candidates: candidates.slice(0, policy.maxReportItems),
    omitted: Math.max(0, candidates.length - policy.maxReportItems),
    total: candidates.length,
  };
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  try {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
      throw new Error(
        'Usage: agent-workflow retention [--check]',
      );
    }
    const report = buildRetentionReport();
    process.stdout.write(
      `Workflow Retention（report-only）: ${report.total} 个候选。\n`,
    );
    report.candidates.forEach((candidate) =>
      process.stdout.write(
        `- ${candidate.kind}: ${candidate.path} (${candidate.ageDays} days)\n`,
      ));
    if (report.omitted > 0) {
      process.stdout.write(`- 另有 ${report.omitted} 个候选未显示。\n`);
    }
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`Workflow Retention 检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
