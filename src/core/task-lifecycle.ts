import { loadRoutes } from './context-budget.js';
import type {
  RoutesConfig,
  RouteTaskFlow,
  StageStatus,
  TaskStageState,
} from '../types/contracts.js';
import { errorMessage } from '../types/guards.js';

export interface ManifestModel {
  currentStage: string;
  entryMode: string;
  lastUpdated: string;
  nextPendingStage: string;
  routeId: string;
  runId: string;
  schemaVersion: number;
  stages: TaskStageState[];
  stateMode: string;
  status: string;
  taskId: string;
}

export type TaskTransitionCommand =
  'advance' | 'block' | 'complete' | 'resume' | 'skip' | 'start';

export interface TaskTransitionOptions {
  action?: string;
  command: TaskTransitionCommand;
  evidence?: string;
  reason?: string;
  stage?: string;
  to?: string;
  updatedAt?: string;
  userApproved?: boolean;
}

interface ManifestSection {
  body: string;
  bodyEnd: number;
  bodyStart: number;
}

interface ResumeFields {
  blockers: string;
  lastCompletedStage: string;
  nextAction: string;
  nextPendingStage: string;
}

const STAGE_STATUS_VALUES = new Set<StageStatus>([
  'pending',
  'in_progress',
  'blocked',
  'complete',
  'skipped',
]);
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isValidDateTime = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const match = value.match(DATE_TIME_PATTERN);
  if (!match) {
    return false;
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText = '0',
    offsetMinuteText = '0',
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  return day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    !Number.isNaN(Date.parse(value));
};

const findSection = (content: string, sectionName: string): ManifestSection => {
  const headingPattern = new RegExp(`^## ${escapeRegExp(sectionName)}\\r?$`, 'm');
  const headingMatch = headingPattern.exec(content);
  if (!headingMatch) {
    throw new Error(`manifest 缺少 ${sectionName} 小节`);
  }
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const remainingContent = content.slice(bodyStart);
  const nextHeadingOffset = remainingContent.search(/^##\s/m);
  const bodyEnd = nextHeadingOffset < 0
    ? content.length
    : bodyStart + nextHeadingOffset;
  return {
    body: content.slice(bodyStart, bodyEnd),
    bodyEnd,
    bodyStart,
  };
};

const readField = (section: string, fieldName: string): string => {
  const pattern = new RegExp(`^- ${escapeRegExp(fieldName)}:\\s*(.*)$`, 'm');
  return section.match(pattern)?.[1]?.trim() ?? '';
};

const replaceSectionField = (
  content: string,
  sectionName: string,
  fieldName: string,
  value: string,
): string => {
  const section = findSection(content, sectionName);
  const fieldPattern = new RegExp(`^- ${escapeRegExp(fieldName)}:.*$`, 'm');
  if (!fieldPattern.test(section.body)) {
    throw new Error(`manifest 的 ${sectionName} 缺少 ${fieldName} 字段`);
  }
  const body = section.body.replace(fieldPattern, `- ${fieldName}: ${value}`);
  return [
    content.slice(0, section.bodyStart),
    body,
    content.slice(section.bodyEnd),
  ].join('');
};

const readStages = (content: string): TaskStageState[] => {
  const section = findSection(content, 'Stage Status');
  return section.body
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(
        /^\|\s*([^|\r\n]+?)\s*\|\s*(pending|in_progress|complete|blocked|skipped)\s*\|\s*(.*?)\s*\|\s*$/,
      );
      const name = match?.[1]?.trim();
      const status = match?.[2] as StageStatus | undefined;
      if (!match || !name || name === 'Stage' || !status) {
        return [];
      }
      return [{
        evidence: match[3]?.trim() ?? '',
        name,
        status,
      }];
    });
};

const replaceStage = (
  content: string,
  stageName: string,
  status: StageStatus,
  evidence: string,
): string => {
  if (!STAGE_STATUS_VALUES.has(status)) {
    throw new Error(`非法阶段状态：${status}`);
  }
  const safeEvidence = cleanInline(evidence, '阶段证据');
  const section = findSection(content, 'Stage Status');
  const lines = section.body.split(/\r?\n/);
  let replaced = false;
  const body = lines.map((line) => {
    const match = line.match(
      /^\|\s*([^|\r\n]+?)\s*\|\s*(pending|in_progress|complete|blocked|skipped)\s*\|.*\|\s*$/,
    );
    if (!match || match[1]?.trim() !== stageName) {
      return line;
    }
    replaced = true;
    return `| ${stageName} | ${status} | ${safeEvidence} |`;
  }).join('\n');
  if (!replaced) {
    throw new Error(`manifest 缺少阶段 ${stageName}`);
  }
  return [
    content.slice(0, section.bodyStart),
    body,
    content.slice(section.bodyEnd),
  ].join('');
};

const cleanInline = (
  value: unknown,
  label: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!allowEmpty && !normalized) {
    throw new Error(`${label}不能为空`);
  }
  if (/[\r\n|]/.test(normalized)) {
    throw new Error(`${label}不能包含换行或表格分隔符`);
  }
  return normalized;
};

const readOptionalSectionField = (
  content: string,
  sectionName: string,
  fieldName: string,
): string => {
  try {
    return readField(findSection(content, sectionName).body, fieldName);
  } catch {
    // Legacy manifests may predate optional sections; route gates decide when the field
    // is required instead of making read-only retention/reporting fail globally.
    return '';
  }
};

export const readManifestModel = (content: string): ManifestModel => {
  const identity = findSection(content, 'Identity').body;
  const resume = findSection(content, 'Resume').body;
  return {
    currentStage: readField(identity, 'Current Stage'),
    entryMode: readOptionalSectionField(content, 'Source Record', 'Entry Mode'),
    lastUpdated: readField(identity, 'Last Updated'),
    routeId: readField(identity, 'Route ID'),
    runId: readField(identity, 'Run ID'),
    schemaVersion: Number(readField(identity, 'Schema Version')),
    stages: readStages(content),
    stateMode: readField(identity, 'State Mode'),
    status: readField(identity, 'Status'),
    taskId: readField(identity, 'Task ID'),
    nextPendingStage: readField(resume, 'Next Pending Stage'),
  };
};

const taskFlowFor = (
  routeId: string,
  config: RoutesConfig = loadRoutes(),
): RouteTaskFlow => {
  const route = config.routes[routeId];
  if (!route) {
    throw new Error(`manifest Route ID 不存在：${routeId || '空'}`);
  }
  if (!route.taskFlow) {
    throw new Error(`Route ${routeId} 未定义 taskFlow`);
  }
  return route.taskFlow;
};

export const validateManifestTaskFlow = (
  model: ManifestModel,
  config: RoutesConfig = loadRoutes(),
): string[] => {
  const errors: string[] = [];
  if (model.schemaVersion !== 1) {
    errors.push('Schema Version 必须为 1');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(model.taskId)) {
    errors.push('Task ID 不符合 Schema');
  }
  if (!/^run-[a-z0-9]{16,64}$/.test(model.runId)) {
    errors.push('Run ID 不符合 Schema');
  }
  if (!['Conversation', 'Portable'].includes(model.stateMode)) {
    errors.push('State Mode 不符合 Schema');
  }
  if (!['pending', 'in_progress', 'blocked', 'complete'].includes(model.status)) {
    errors.push('Status 不符合 Schema');
  }
  if (!isValidDateTime(model.lastUpdated)) {
    errors.push('Last Updated 必须是合法 date-time');
  }
  model.stages.forEach(({ name, status }) => {
    if (!name || !STAGE_STATUS_VALUES.has(status)) {
      errors.push(`阶段 ${name || '空'} 不符合 Schema`);
    }
  });
  const activeStages = model.stages
    .filter(({ status }) => status === 'in_progress');
  const blockedStages = model.stages
    .filter(({ status }) => status === 'blocked');
  const firstOpenStage = model.stages
    .find(({ status }) => ['pending', 'in_progress', 'blocked'].includes(status));
  if (model.status === 'in_progress' &&
      (activeStages.length !== 1 || activeStages[0]?.name !== model.currentStage)) {
    errors.push('in_progress 任务必须有且只有一个同名 Current Stage');
  }
  if (model.status === 'in_progress' && blockedStages.length > 0) {
    errors.push('in_progress 任务不能包含 blocked 阶段');
  }
  if (model.status === 'blocked' &&
      (blockedStages.length !== 1 || blockedStages[0]?.name !== model.currentStage)) {
    errors.push('blocked 任务必须有且只有一个同名 Current Stage');
  }
  if (model.status === 'blocked' && activeStages.length > 0) {
    errors.push('blocked 任务不能包含 in_progress 阶段');
  }
  if (model.status === 'pending' &&
      firstOpenStage?.name !== model.currentStage) {
    errors.push('pending 任务的 Current Stage 必须是第一个开放阶段');
  }
  if (model.status === 'pending' &&
      (activeStages.length > 0 || blockedStages.length > 0)) {
    errors.push('pending 任务不能包含 in_progress 或 blocked 阶段');
  }
  if (model.status === 'complete' &&
      (firstOpenStage || model.currentStage !== 'complete')) {
    errors.push('complete 任务不能包含开放阶段');
  }
  if (model.status !== 'complete' &&
      firstOpenStage?.name !== model.nextPendingStage) {
    errors.push('Next Pending Stage 必须是第一个开放阶段');
  }
  if (model.status === 'complete' &&
      !['none', '无', 'not applicable', 'n/a'].includes(
        model.nextPendingStage.toLowerCase(),
      )) {
    errors.push('complete 任务的 Next Pending Stage 必须为 none');
  }
  let flow: RouteTaskFlow;
  try {
    flow = taskFlowFor(model.routeId, config);
  } catch (error: unknown) {
    errors.push(errorMessage(error));
    return errors;
  }
  const manifestStageNames = model.stages.map(({ name }) => name);
  if (JSON.stringify(manifestStageNames) !== JSON.stringify(flow.stages)) {
    errors.push(
      `Stage Status 必须与 Route ${model.routeId} 的 taskFlow 顺序一致`,
    );
  }
  model.stages.forEach(({ name, status }) => {
    if (status === 'skipped' && !flow.optionalStages.includes(name)) {
      errors.push(`阶段 ${name} 不允许 skipped`);
    }
  });
  let openSeen = false;
  model.stages.forEach(({ name, status }) => {
    const isOpen = ['pending', 'in_progress', 'blocked'].includes(status);
    if (isOpen) {
      openSeen = true;
    } else if (openSeen && status === 'complete') {
      errors.push(`阶段 ${name} complete 出现在未完成阶段之后`);
    }
  });
  return errors;
};

const updateIdentity = (
  content: string,
  status: string,
  currentStage: string,
  updatedAt: string,
): string => {
  let updated = replaceSectionField(content, 'Identity', 'Status', status);
  updated = replaceSectionField(
    updated,
    'Identity',
    'Current Stage',
    currentStage,
  );
  return replaceSectionField(
    updated,
    'Identity',
    'Last Updated',
    updatedAt,
  );
};

const updateResume = (
  content: string,
  {
    lastCompletedStage,
    nextAction,
    nextPendingStage,
    blockers,
  }: ResumeFields,
): string => {
  let updated = replaceSectionField(
    content,
    'Resume',
    'Last Completed Stage',
    lastCompletedStage,
  );
  updated = replaceSectionField(
    updated,
    'Resume',
    'Next Pending Stage',
    nextPendingStage,
  );
  updated = replaceSectionField(
    updated,
    'Resume',
    'Next Action',
    nextAction,
  );
  return replaceSectionField(
    updated,
    'Resume',
    'Known Blockers',
    blockers,
  );
};

const lastCompleted = (stages: TaskStageState[]): string =>
  stages.findLast(({ status }) => status === 'complete')?.name ?? 'none';

export const transitionManifestContent = (
  originalContent: string,
  {
    action = '',
    command,
    evidence = '',
    reason = '',
    stage = '',
    to = '',
    userApproved = false,
    updatedAt = new Date().toISOString(),
  }: TaskTransitionOptions,
  config: RoutesConfig = loadRoutes(),
): string => {
  if (!isValidDateTime(updatedAt)) {
    throw new Error('updatedAt 必须是合法 date-time');
  }
  const model = readManifestModel(originalContent);
  const flowErrors = validateManifestTaskFlow(model, config);
  if (flowErrors.length > 0) {
    throw new Error(flowErrors[0]);
  }
  const flow = taskFlowFor(model.routeId, config);
  const stageByName = new Map(model.stages.map((item) => [item.name, item]));
  const current = stageByName.get(model.currentStage);
  if (userApproved && command !== 'advance') {
    throw new Error(
      'Implementation Approval Gate: --user-approved 只允许用于转入 Implement',
    );
  }

  if (command === 'start') {
    if (model.status !== 'pending' || current?.status !== 'pending') {
      throw new Error('start 只接受当前首阶段为 pending 的任务');
    }
    const safeAction = cleanInline(action, 'Next Action');
    let content = replaceStage(originalContent, current.name, 'in_progress', safeAction);
    content = updateIdentity(content, 'in_progress', current.name, updatedAt);
    return updateResume(content, {
      blockers: 'none',
      lastCompletedStage: lastCompleted(model.stages),
      nextAction: safeAction,
      nextPendingStage: current.name,
    });
  }

  if (command === 'skip') {
    const targetStage = cleanInline(stage, 'Stage');
    const safeReason = cleanInline(reason, 'Skip reason');
    const target = stageByName.get(targetStage);
    if (!target || target.status !== 'pending') {
      throw new Error('skip 只接受 pending 阶段');
    }
    if (!flow.optionalStages.includes(targetStage)) {
      throw new Error(`阶段 ${targetStage} 不允许 skipped`);
    }
    const content = replaceStage(
      originalContent,
      targetStage,
      'skipped',
      safeReason,
    );
    return updateIdentity(content, model.status, model.currentStage, updatedAt);
  }

  if (command === 'block') {
    if (model.status !== 'in_progress' || current?.status !== 'in_progress') {
      throw new Error('block 只接受 in_progress 任务');
    }
    const safeReason = cleanInline(reason, 'Block reason');
    let content = replaceStage(originalContent, current.name, 'blocked', safeReason);
    content = updateIdentity(content, 'blocked', current.name, updatedAt);
    return updateResume(content, {
      blockers: safeReason,
      lastCompletedStage: lastCompleted(model.stages),
      nextAction: safeReason,
      nextPendingStage: current.name,
    });
  }

  if (command === 'resume') {
    if (model.status !== 'blocked' || current?.status !== 'blocked') {
      throw new Error('resume 只接受 blocked 任务');
    }
    const safeAction = cleanInline(action, 'Next Action');
    let content = replaceStage(originalContent, current.name, 'in_progress', safeAction);
    content = updateIdentity(content, 'in_progress', current.name, updatedAt);
    return updateResume(content, {
      blockers: 'none',
      lastCompletedStage: lastCompleted(model.stages),
      nextAction: safeAction,
      nextPendingStage: current.name,
    });
  }

  if (command === 'advance') {
    if (model.status !== 'in_progress' || current?.status !== 'in_progress') {
      throw new Error('advance 只接受 in_progress 任务');
    }
    const targetStage = cleanInline(to, 'Target stage');
    const safeEvidence = cleanInline(evidence, 'Completion evidence');
    const safeAction = cleanInline(action, 'Next Action');
    if (userApproved && targetStage !== 'Implement') {
      throw new Error(
        'Implementation Approval Gate: --user-approved 只允许用于转入 Implement',
      );
    }
    if (!flow.transitions[current.name]?.includes(targetStage)) {
      throw new Error(`${current.name} 不能转换到 ${targetStage}`);
    }
    if (targetStage === 'Implement' && !userApproved) {
      throw new Error(
        'Implementation Approval Gate: Plan 转入 Implement 前必须获得用户明确批准；' +
        '批准后使用 --user-approved',
      );
    }
    const target = stageByName.get(targetStage);
    if (!target || target.status !== 'pending') {
      throw new Error(`目标阶段 ${targetStage} 必须为 pending`);
    }
    const currentIndex = flow.stages.indexOf(current.name);
    const targetIndex = flow.stages.indexOf(targetStage);
    const unresolvedBetween = flow.stages
      .slice(currentIndex + 1, targetIndex)
      .map((name) => stageByName.get(name))
      .filter((item): item is TaskStageState => Boolean(item))
      .filter(({ status }) => !['complete', 'skipped'].includes(status));
    if (unresolvedBetween.length > 0) {
      throw new Error(
        `转换前必须完成或跳过阶段：${unresolvedBetween.map(({ name }) => name).join(', ')}`,
      );
    }
    let content = replaceStage(
      originalContent,
      current.name,
      'complete',
      safeEvidence,
    );
    content = replaceStage(content, targetStage, 'in_progress', safeAction);
    content = updateIdentity(content, 'in_progress', targetStage, updatedAt);
    return updateResume(content, {
      blockers: 'none',
      lastCompletedStage: current.name,
      nextAction: safeAction,
      nextPendingStage: targetStage,
    });
  }

  if (command === 'complete') {
    if (model.status !== 'in_progress' || current?.status !== 'in_progress') {
      throw new Error('complete 只接受 in_progress 任务');
    }
    const safeEvidence = cleanInline(evidence, 'Completion evidence');
    if (!flow.transitions[current.name]?.includes('complete')) {
      throw new Error(`阶段 ${current.name} 不能直接完成任务`);
    }
    const otherOpenStages = model.stages.filter(({ name, status }) =>
      name !== current.name &&
      ['pending', 'in_progress', 'blocked'].includes(status));
    if (otherOpenStages.length > 0) {
      throw new Error(
        `仍有未完成阶段：${otherOpenStages.map(({ name }) => name).join(', ')}`,
      );
    }
    let content = replaceStage(
      originalContent,
      current.name,
      'complete',
      safeEvidence,
    );
    content = updateIdentity(content, 'complete', 'complete', updatedAt);
    return updateResume(content, {
      blockers: 'none',
      lastCompletedStage: current.name,
      nextAction: 'none',
      nextPendingStage: 'none',
    });
  }

  throw new Error(`未知任务状态命令：${command}`);
};
