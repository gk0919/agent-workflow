import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadWorkflowPaths } from '../config/workflow-config.js';
import {
  loadRoutes,
} from './context-budget.js';
import { errorMessage } from '../types/guards.js';

interface WorkflowEventInput {
  [key: string]: unknown;
  budgetChars?: unknown;
  changeType?: unknown;
  durationMs?: unknown;
  entry?: unknown;
  errorCode?: unknown;
  eventType?: unknown;
  fallbackCode?: unknown;
  fromStage?: unknown;
  gate?: unknown;
  implementationApproved?: unknown;
  loadedChars?: unknown;
  manualOverride?: unknown;
  materializationComplete?: unknown;
  materializationRequested?: unknown;
  materialized?: unknown;
  materializedDocsCount?: unknown;
  microBriefHash?: unknown;
  microBriefPlanHash?: unknown;
  microPatchHash?: unknown;
  microRepositoryId?: unknown;
  microSourceHash?: unknown;
  omittedDocsCount?: unknown;
  outcome?: unknown;
  outputChars?: unknown;
  parentRunId?: unknown;
  requestedOutputChars?: unknown;
  result?: unknown;
  resultKind?: unknown;
  riskFlags?: unknown;
  route?: unknown;
  routesVersion?: unknown;
  runId?: unknown;
  skills?: unknown;
  stage?: unknown;
  timestamp?: unknown;
  toStage?: unknown;
  usedChars?: unknown;
}

export interface WorkflowEvent {
  budgetChars: number;
  changeType: string;
  durationMs: number;
  entry: string;
  errorCode: string | null;
  eventType: string;
  fallbackCode: string;
  fromStage: string;
  gate: string;
  implementationApproved: boolean;
  loadedChars: number;
  manualOverride: boolean;
  materializationComplete: boolean;
  materializationRequested: boolean;
  materialized: boolean;
  materializedDocsCount: number;
  microBriefHash: string;
  microBriefPlanHash: string;
  microPatchHash: string;
  microRepositoryId: string;
  microSourceHash: string;
  omittedDocsCount: number;
  outcome: string;
  outputChars: number;
  parentRunId: string;
  requestedOutputChars: number;
  result: string;
  resultKind: string;
  riskFlags: string[];
  route: string;
  routesVersion: number;
  runId: string;
  schemaVersion: 8;
  skills: string[];
  stage: string;
  timestamp: string;
  toStage: string;
  usedChars: number;
}

export interface LoadedRouteEvents {
  events: WorkflowEvent[];
  invalidRows: number;
}

export interface FilteredRouteEvents extends LoadedRouteEvents {
  currentRoutesVersion: number;
  excludedEvents: number;
  includesLegacy: boolean;
}

interface RouteAggregate {
  calls: number;
  durationMs: number;
  errors: number;
  loadedChars: number;
  materialized: number;
  outputChars: number;
}

type CountEntry = [string, number];
type RouteEntry = [string, RouteAggregate];

export interface FeedbackSummary {
  currentRoutesVersion: number;
  eventCount: number;
  eventTypes: CountEntry[];
  excludedEvents: number;
  failures: CountEntry[];
  fallbacks: CountEntry[];
  implementationApprovals: number;
  includesLegacy: boolean;
  invalidRows: number;
  linkedRuns: number;
  manualOverrides: number;
  materializationComplete: number;
  materializationPartial: number;
  materializationRequested: number;
  outcomes: CountEntry[];
  resultKinds: CountEntry[];
  risks: CountEntry[];
  routeEventCount: number;
  routes: RouteEntry[];
  routeVersions: CountEntry[];
  runLineages: number;
  skills: CountEntry[];
  unlinkedEvents: number;
}

export const defaultLogsRoot = path.join(
  loadWorkflowPaths().runtimeRoot,
  'logs',
);
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_ID_PATTERN = /^run-[a-z0-9]{16,64}$/;
const STAGE_PATTERN = /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/;
const RESULT_VALUES = new Set<string>(['success', 'error']);
const RESULT_KIND_VALUES = new Set<string>([
  'allowed',
  'blocked',
  'internal-error',
  'invalid-input',
  'unknown-error',
]);
const EVENT_TYPE_VALUES = new Set<string>([
  'route',
  'route-corrected',
  'risk-added',
  'human-override',
  'stage-transition',
  'verify-gap',
  'task-outcome',
]);
const OUTCOME_VALUES = new Set<string>([
  'unknown',
  'in-progress',
  'blocked',
  'partial',
  'complete',
  'abandoned',
]);
const MAX_REPORT_CHARS = 4000;

const safeIdentifier = (value: unknown, fallback = 'unknown'): string =>
  typeof value === 'string' && IDENTIFIER_PATTERN.test(value) ? value : fallback;

export const isValidRunId = (value: unknown): value is string =>
  typeof value === 'string' && RUN_ID_PATTERN.test(value);

export const createRunId = (): string => `run-${randomBytes(8).toString('hex')}`;

const safeRunId = (value: unknown): string => isValidRunId(value) ? value : 'unlinked';
const safeOptionalRunId = (value: unknown): string => isValidRunId(value) ? value : 'none';

const safeStage = (value: unknown): string =>
  typeof value === 'string' && STAGE_PATTERN.test(value.trim())
    ? value.trim().toLowerCase().replace(/ +/g, '-')
    : 'unknown';

const safeInteger = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;

const safeHash = (value: unknown, length: number): string =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
    ? value
    : 'none';

const safeTimestamp = (value: unknown): string => {
  const timestamp = typeof value === 'string' ? value : new Date().toISOString();
  return Number.isNaN(Date.parse(timestamp)) ? new Date().toISOString() : timestamp;
};

export const classifyRouteError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const patterns: Array<[RegExp, string]> = [
    [/未知 Route/, 'unknown-route'],
    [/不包含 Stage/, 'invalid-stage'],
    [/不接受 Entry/, 'invalid-entry'],
    [/未知 Risk Flag/, 'unknown-risk'],
    [/禁止风险标识/, 'blocked-risk'],
    [/结构化事实判定|结构化事实分类|全部 Gate 事实/, 'classification-gate'],
    [/Implementation Approval Gate:/, 'implementation-approval-gate'],
    [/Run Route Gate:/, 'run-route-gate'],
    [/Micro Brief Gate:/, 'micro-brief-gate'],
    [/Micro Change Source Gate:/, 'micro-source-gate'],
    [/Micro Change Run Gate:/, 'micro-run-gate'],
    [/Micro Change.*(?:patch|实际范围)/, 'micro-scope-gate'],
    [/必须复用首阶段 Packet 的 --run-id/, 'run-id-required'],
    [/Skill .*不存在|Skill 名称非法/, 'invalid-skill'],
    [/必须提供 --route|缺少值|未知参数|只支持 text 或 json|不能同时使用|不允许 Reference/,
      'invalid-arguments'],
    [/超过工具输出上限/, 'tool-output-exceeded'],
    [/超过.*预算/, 'context-budget-exceeded'],
    [/路由配置未通过校验/, 'invalid-config'],
    [/Task Gate:/, 'task-gate'],
  ];
  return patterns.find(([pattern]) => pattern.test(message))?.[1] ?? 'route-error';
};

const resultKindForErrorCode = (errorCode: string): string => {
  if (errorCode.endsWith('-gate') || errorCode === 'blocked-risk' ||
      errorCode === 'context-budget-exceeded') {
    return 'blocked';
  }
  if (errorCode === 'invalid-config') {
    return 'internal-error';
  }
  if (errorCode === 'route-error') {
    return 'unknown-error';
  }
  return 'invalid-input';
};

const materializationRequestedFor = (event: WorkflowEventInput): boolean =>
  Object.hasOwn(event, 'materializationRequested')
    ? Boolean(event.materializationRequested)
    : Boolean(event.materialized) ||
      ['partial-materialize', 'tool-output-exceeded'].includes(String(event.fallbackCode));

const materializationCompleteFor = (event: WorkflowEventInput): boolean =>
  Object.hasOwn(event, 'materializationComplete')
    ? Boolean(event.materializationComplete)
    : materializationRequestedFor(event) && Boolean(event.materialized) &&
      event.fallbackCode !== 'partial-materialize';

/** Separates expected policy/input rejections from internal runtime failures. */
export const classifyRouteResult = (error: unknown): string => {
  const errorCode = classifyRouteError(error);
  return resultKindForErrorCode(errorCode);
};

export const normalizeWorkflowEvent = (event: WorkflowEventInput = {}): WorkflowEvent => ({
  schemaVersion: 8,
  timestamp: safeTimestamp(event.timestamp),
  eventType: typeof event.eventType === 'string' && EVENT_TYPE_VALUES.has(event.eventType)
    ? event.eventType
    : 'route',
  runId: safeRunId(event.runId),
  parentRunId: safeOptionalRunId(event.parentRunId),
  route: safeIdentifier(event.route),
  changeType: safeIdentifier(event.changeType, 'none'),
  stage: safeStage(event.stage),
  fromStage: safeStage(event.fromStage),
  toStage: safeStage(event.toStage),
  entry: safeIdentifier(event.entry),
  skills: [...new Set(Array.isArray(event.skills) ? event.skills : [])]
    .map((skill) => safeIdentifier(skill)),
  riskFlags: [...new Set(Array.isArray(event.riskFlags) ? event.riskFlags : [])]
    .map((riskFlag) => safeIdentifier(riskFlag)),
  result: typeof event.result === 'string' && RESULT_VALUES.has(event.result)
    ? event.result
    : 'error',
  resultKind: typeof event.resultKind === 'string' && RESULT_KIND_VALUES.has(event.resultKind)
    ? event.resultKind
    : event.result === 'success'
      ? 'allowed'
      : resultKindForErrorCode(safeIdentifier(event.errorCode, 'route-error')),
  outcome: typeof event.outcome === 'string' && OUTCOME_VALUES.has(event.outcome)
    ? event.outcome
    : 'unknown',
  gate: safeIdentifier(event.gate),
  manualOverride: Boolean(event.manualOverride),
  implementationApproved: Boolean(event.implementationApproved),
  errorCode: event.result === 'success'
    ? null
    : safeIdentifier(event.errorCode, 'route-error'),
  fallbackCode: safeIdentifier(event.fallbackCode, 'none'),
  materializationRequested: materializationRequestedFor(event),
  materializationComplete: materializationCompleteFor(event),
  materialized: Boolean(event.materialized),
  materializedDocsCount: safeInteger(event.materializedDocsCount),
  omittedDocsCount: safeInteger(event.omittedDocsCount),
  durationMs: safeInteger(event.durationMs),
  loadedChars: safeInteger(event.loadedChars),
  usedChars: safeInteger(event.usedChars),
  budgetChars: safeInteger(event.budgetChars),
  outputChars: safeInteger(event.outputChars),
  requestedOutputChars: safeInteger(event.requestedOutputChars),
  routesVersion: safeInteger(event.routesVersion),
  microRepositoryId: safeHash(event.microRepositoryId, 12),
  microBriefHash: safeHash(event.microBriefHash, 16),
  microBriefPlanHash: safeHash(event.microBriefPlanHash, 16),
  microPatchHash: safeHash(event.microPatchHash, 16),
  microSourceHash: safeHash(event.microSourceHash, 16),
});

export const normalizeRouteEvent = (event: WorkflowEventInput = {}): WorkflowEvent =>
  normalizeWorkflowEvent({
    ...event,
    eventType: 'route',
  });

export const recordWorkflowEvent = (
  event: WorkflowEventInput,
  { logsRoot = defaultLogsRoot }: { logsRoot?: string } = {},
): string => {
  const normalizedEvent = normalizeWorkflowEvent({
    ...event,
    routesVersion: event.routesVersion ?? loadRoutes().version,
  });
  mkdirSync(logsRoot, { recursive: true });
  const datePart = normalizedEvent.timestamp.slice(0, 10);
  const logPath = path.join(logsRoot, `workflow-${datePart}.jsonl`);
  appendFileSync(logPath, `${JSON.stringify(normalizedEvent)}\n`, 'utf8');
  return logPath;
};

export const recordRouteEvent = (
  event: WorkflowEventInput,
  options: { logsRoot?: string } = {},
): string =>
  recordWorkflowEvent({
    ...event,
    eventType: 'route',
  }, options);

export const loadRouteEvents = ({
  days = 7,
  logsRoot = defaultLogsRoot,
  now = Date.now(),
}: { days?: number; logsRoot?: string; now?: number } = {}): LoadedRouteEvents => {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error('days 必须是 1 到 90 的整数');
  }
  if (!existsSync(logsRoot)) {
    return {
      events: [],
      invalidRows: 0,
    };
  }

  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let invalidRows = 0;
  const events = readdirSync(logsRoot)
    .filter((fileName) =>
      /^(?:route|workflow)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName))
    .sort()
    .flatMap((fileName) =>
      readFileSync(path.join(logsRoot, fileName), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const event = JSON.parse(line) as WorkflowEventInput;
            const eventTimestamp = typeof event.timestamp === 'string'
              ? Date.parse(event.timestamp)
              : Number.NaN;
            if (Number.isNaN(eventTimestamp)) {
              invalidRows += 1;
              return [];
            }
            return eventTimestamp >= cutoff ? [normalizeWorkflowEvent(event)] : [];
          } catch {
            invalidRows += 1;
            return [];
          }
        }));
  return {
    events,
    invalidRows,
  };
};

export const filterRouteEventsByVersion = (
  loaded: LoadedRouteEvents,
  {
    includeLegacy = false,
    routesVersion = loadRoutes().version,
  }: { includeLegacy?: boolean; routesVersion?: number } = {},
): FilteredRouteEvents => {
  if (includeLegacy) {
    return {
      ...loaded,
      currentRoutesVersion: routesVersion,
      excludedEvents: 0,
      includesLegacy: true,
    };
  }
  const events = loaded.events.filter((event) =>
    safeInteger(event.routesVersion) === routesVersion);
  return {
    ...loaded,
    currentRoutesVersion: routesVersion,
    events,
    excludedEvents: loaded.events.length - events.length,
    includesLegacy: false,
  };
};

const increment = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) || 0) + 1);
};

export const summarizeRouteEvents = ({
  currentRoutesVersion = 0,
  events,
  excludedEvents = 0,
  includesLegacy = true,
  invalidRows = 0,
}: LoadedRouteEvents & Partial<
  Pick<FilteredRouteEvents, 'currentRoutesVersion' | 'excludedEvents' | 'includesLegacy'>
>): FeedbackSummary => {
  const routes = new Map<string, RouteAggregate>();
  const skills = new Map<string, number>();
  const failures = new Map<string, number>();
  const risks = new Map<string, number>();
  const eventTypes = new Map<string, number>();
  const fallbacks = new Map<string, number>();
  const outcomes = new Map<string, number>();
  const routeVersions = new Map<string, number>();
  const resultKinds = new Map<string, number>();
  const linkedRuns = new Set<string>();
  const runLineages = new Set<string>();
  let implementationApprovals = 0;
  let materializationComplete = 0;
  let materializationPartial = 0;
  let materializationRequested = 0;
  let manualOverrides = 0;
  let unlinkedEvents = 0;
  let routeEventCount = 0;

  events.forEach((event) => {
    if (event.eventType === 'route') {
      const routesVersion = safeInteger(event.routesVersion);
      const routeVersionLabel = routesVersion > 0 ? `v${routesVersion}` : 'unknown';
      const routeKey =
        `${routeVersionLabel}/${safeIdentifier(event.route)}/${safeIdentifier(event.stage)}`;
      const current = routes.get(routeKey) || {
        calls: 0,
        durationMs: 0,
        errors: 0,
        loadedChars: 0,
        materialized: 0,
        outputChars: 0,
      };
      current.calls += 1;
      current.durationMs += safeInteger(event.durationMs);
      current.loadedChars += safeInteger(event.loadedChars);
      current.outputChars += safeInteger(event.outputChars);
      current.materialized += event.materialized ? 1 : 0;
      current.errors += event.result === 'error' ? 1 : 0;
      routes.set(routeKey, current);
      increment(routeVersions, routeVersionLabel);
      routeEventCount += 1;
    }

    (event.skills || []).forEach((skill) =>
      increment(skills, safeIdentifier(skill)));
    (event.riskFlags || []).forEach((riskFlag) =>
      increment(risks, safeIdentifier(riskFlag)));
    if (event.result === 'error') {
      increment(failures, safeIdentifier(event.errorCode, 'route-error'));
    }
    if (event.fallbackCode && event.fallbackCode !== 'none') {
      increment(fallbacks, safeIdentifier(event.fallbackCode));
    }
    if (event.runId && event.runId !== 'unlinked') {
      linkedRuns.add(event.runId);
      if (event.parentRunId && event.parentRunId !== 'none') {
        runLineages.add(`${event.parentRunId}>${event.runId}`);
      }
    } else {
      unlinkedEvents += 1;
    }
    increment(eventTypes, safeIdentifier(event.eventType));
    increment(resultKinds, safeIdentifier(event.resultKind, 'unknown-error'));
    if (event.outcome && event.outcome !== 'unknown') {
      increment(outcomes, safeIdentifier(event.outcome));
    }
    manualOverrides += event.manualOverride ? 1 : 0;
    implementationApprovals += event.implementationApproved ? 1 : 0;
    if (event.materializationRequested) {
      materializationRequested += 1;
      if (event.materializationComplete) {
        materializationComplete += 1;
      } else if (event.materialized) {
        materializationPartial += 1;
      }
    }
  });

  const byCount = (left: CountEntry, right: CountEntry): number =>
    right[1] - left[1] || left[0].localeCompare(right[0]);
  return {
    currentRoutesVersion,
    eventCount: events.length,
    eventTypes: [...eventTypes].sort(byCount),
    excludedEvents,
    fallbacks: [...fallbacks].sort(byCount),
    failures: [...failures].sort(byCount),
    includesLegacy,
    invalidRows,
    implementationApprovals,
    materializationComplete,
    materializationPartial,
    materializationRequested,
    linkedRuns: linkedRuns.size,
    manualOverrides,
    outcomes: [...outcomes].sort(byCount),
    risks: [...risks].sort(byCount),
    resultKinds: [...resultKinds].sort(byCount),
    routeEventCount,
    runLineages: runLineages.size,
    routeVersions: [...routeVersions].sort(byCount),
    routes: [...routes]
      .sort((left, right) =>
        right[1].calls - left[1].calls || left[0].localeCompare(right[0])),
    skills: [...skills].sort(byCount),
    unlinkedEvents,
  };
};

const average = (total: number, count: number): number =>
  count === 0 ? 0 : Math.round(total / count);

export const formatFeedbackSummary = (summary: FeedbackSummary, days: number): string => {
  const lines: string[] = [
    `Workflow Feedback（最近 ${days} 天）`,
    `- Events: ${summary.eventCount}`,
    `- Invalid Rows: ${summary.invalidRows}`,
  ];
  if (summary.currentRoutesVersion > 0) {
    lines.push(
      `- Routes Version: ${summary.includesLegacy
        ? 'all'
        : `v${summary.currentRoutesVersion}`} ` +
      `(excluded legacy: ${summary.excludedEvents})`,
    );
  }
  lines.push(
    `- Route Events: ${summary.routeEventCount ?? 0}; ` +
    `Lifecycle Events: ${summary.eventCount - (summary.routeEventCount ?? 0)}`,
    `- Linked Runs: ${summary.linkedRuns}; Parent Links: ${summary.runLineages ?? 0}; ` +
      `Unlinked Events: ${summary.unlinkedEvents}`,
    `- Implementation Approvals: ${summary.implementationApprovals ?? 0}`,
    `- Materialization Requests: ${summary.materializationRequested ?? 0}; ` +
      `Complete: ${summary.materializationComplete ?? 0}; ` +
      `Partial: ${summary.materializationPartial ?? 0}; ` +
      `Fallback: ${Math.max(0,
        (summary.materializationRequested ?? 0) -
        (summary.materializationComplete ?? 0) -
        (summary.materializationPartial ?? 0))}`,
  );
  if (summary.eventCount === 0) {
    return lines.concat('- 暂无匿名化路由日志。').join('\n');
  }

  lines.push(
    '',
    'Config / Route | Calls | Errors | Materialized | Avg ms | Avg Loaded | Avg Output',
    '---|---:|---:|---:|---:|---:|---:',
    ...summary.routes.slice(0, 20).map(([route, values]) =>
      `${route} | ${values.calls} | ${values.errors} | ${values.materialized} | ` +
      `${average(values.durationMs, values.calls)} | ` +
      `${average(values.loadedChars, values.calls)} | ` +
      `${average(values.outputChars, values.calls)}`),
  );
  if (summary.skills.length > 0) {
    lines.push(
      '',
      `Top Skills: ${summary.skills.slice(0, 15)
        .map(([skill, count]) => `${skill}(${count})`).join(', ')}`,
    );
  }
  if (summary.risks.length > 0) {
    lines.push(
      `Risk Flags: ${summary.risks.slice(0, 15)
        .map(([risk, count]) => `${risk}(${count})`).join(', ')}`,
    );
  }
  if (summary.routeVersions.length > 0) {
    lines.push(
      `Route Config Versions: ${summary.routeVersions
        .map(([version, count]) => `${version}(${count})`).join(', ')}`,
    );
  }
  if (summary.resultKinds?.length > 0) {
    lines.push(
      `Result Kinds: ${summary.resultKinds
        .map(([resultKind, count]) => `${resultKind}(${count})`).join(', ')}`,
    );
  }
  if (summary.fallbacks.length > 0) {
    lines.push(
      `Fallbacks: ${summary.fallbacks.slice(0, 15)
        .map(([fallback, count]) => `${fallback}(${count})`).join(', ')}`,
    );
  }
  if (summary.failures.length > 0) {
    lines.push(
      `Failures: ${summary.failures.slice(0, 10)
        .map(([failure, count]) => `${failure}(${count})`).join(', ')}`,
    );
  }
  if (summary.eventTypes.length > 0) {
    lines.push(
      `Event Types: ${summary.eventTypes.slice(0, 12)
        .map(([eventType, count]) => `${eventType}(${count})`).join(', ')}`,
    );
  }
  if (summary.outcomes.length > 0) {
    lines.push(
      `Outcomes: ${summary.outcomes.slice(0, 10)
        .map(([outcome, count]) => `${outcome}(${count})`).join(', ')}`,
    );
  }
  if (summary.manualOverrides > 0) {
    lines.push(`Manual Overrides: ${summary.manualOverrides}`);
  }

  const output = lines.join('\n');
  if (Array.from(output).length > MAX_REPORT_CHARS) {
    throw new Error(`反馈摘要超过 ${MAX_REPORT_CHARS} 字符，请缩短聚合维度`);
  }
  return output;
};

const readFeedbackOptions = (args: string[]): { days: number; includeLegacy: boolean } => {
  const options = {
    days: 7,
    includeLegacy: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--include-legacy') {
      options.includeLegacy = true;
      continue;
    }
    if (argument === '--days') {
      const days = Number(args[index + 1]);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        throw new Error('--days 必须是 1 到 90 的整数');
      }
      options.days = days;
      index += 1;
      continue;
    }
    throw new Error(
      'Usage: agent-workflow feedback [--days <1-90>] [--include-legacy]',
    );
  }
  return options;
};

const readRecordEvent = (args: string[]): WorkflowEventInput => {
  const event: WorkflowEventInput = {
    eventType: '',
    manualOverride: false,
    result: 'success',
  };
  const valueOptions = new Map<string, string>([
    ['--entry', 'entry'],
    ['--event', 'eventType'],
    ['--from-stage', 'fromStage'],
    ['--gate', 'gate'],
    ['--outcome', 'outcome'],
    ['--route', 'route'],
    ['--run-id', 'runId'],
    ['--stage', 'stage'],
    ['--to-stage', 'toStage'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--manual-override') {
      event.manualOverride = true;
      continue;
    }
    const field = valueOptions.get(argument ?? '');
    if (!field) {
      throw new Error(`未知 record 参数：${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} 缺少值`);
    }
    event[field] = value;
    index += 1;
  }
  if (typeof event.eventType !== 'string' ||
      !EVENT_TYPE_VALUES.has(event.eventType) || event.eventType === 'route') {
    throw new Error(
      '--event 必须是 route-corrected、risk-added、human-override、' +
      'stage-transition、verify-gap 或 task-outcome',
    );
  }
  if (typeof event.outcome === 'string' && !OUTCOME_VALUES.has(event.outcome)) {
    throw new Error(`未知 outcome：${event.outcome}`);
  }
  if (event.runId && !isValidRunId(event.runId)) {
    throw new Error('--run-id 必须符合 run-<16-64 位小写字母或数字>');
  }
  if (!event.runId) {
    throw new Error('匿名工作流事件必须提供 --run-id');
  }
  ['entry', 'gate', 'route'].forEach((field) => {
    if (typeof event[field] === 'string' && !IDENTIFIER_PATTERN.test(event[field])) {
      throw new Error(`${field} 必须是小写 kebab-case 标识`);
    }
  });
  ['fromStage', 'stage', 'toStage'].forEach((field) => {
    if (typeof event[field] === 'string' && !STAGE_PATTERN.test(event[field].trim())) {
      throw new Error(`${field} 包含非法字符`);
    }
  });
  return event;
};

export const main = (args = process.argv.slice(2)): number => {
  try {
    if (args[0] === 'record') {
      const event = readRecordEvent(args.slice(1));
      recordWorkflowEvent({
        ...event,
        timestamp: new Date().toISOString(),
      });
      process.stdout.write(`匿名工作流事件已记录：${event.eventType}\n`);
      return 0;
    }
    const options = readFeedbackOptions(args);
    const loaded = loadRouteEvents({ days: options.days });
    const filtered = filterRouteEventsByVersion(loaded, options);
    const summary = summarizeRouteEvents(filtered);
    process.stdout.write(`${formatFeedbackSummary(summary, options.days)}\n`);
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`工作流反馈处理失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
