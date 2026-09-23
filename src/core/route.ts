import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { workflowRelativePath } from '../config/workflow-config.js';
import {
  classifyRouteFacts,
  extractRouteClassificationArgs,
} from './classify-route.js';
import {
  buildRoutePacket,
  formatRoutePacket,
  loadRoutes,
  materializeRoutePacket,
} from './context-budget.js';
import {
  classifyRouteError,
  classifyRouteResult,
  createRunId,
  filterRouteEventsByVersion,
  isValidRunId,
  loadRouteEvents,
  recordRouteEvent,
} from './runtime-log.js';
import {
  guardMicroChangePatch,
  guardMicroRepository,
  MICRO_GUARD_STAGES,
  validateMicroChangeRun,
} from './micro-change-guard.js';
import {
  guardMicroBriefFile,
  MICRO_BRIEF_STAGES,
} from './micro-brief.js';
import { guardRouteTask } from './task-route-guard.js';
import { requirePublishedTask, hasTaskApproval } from './task-checkpoint.js';
import { taskPath } from './task-files.js';
import { readWorkflowInputFile } from './workflow-input.js';
import type {
  RouteClassification,
  RouteFacts,
  MicroBriefSummary,
  MicroGuardSummary,
  RepositoryBinding,
  RoutePacket,
} from '../types/contracts.js';
import type { WorkflowEvent } from './runtime-log.js';
import { errorMessage } from '../types/guards.js';

export interface RouteOptions {
  classificationFacts: Partial<RouteFacts> | null;
  entry: string;
  format: 'json' | 'text';
  level: number | null;
  list: boolean;
  materializeContext: boolean;
  briefFile: string;
  patchFile: string;
  patchStdin: boolean;
  noLog: boolean;
  parentRunId: string;
  references: string[];
  repository: string;
  riskFlags: string[];
  route: string;
  runId: string;
  skills: string[];
  stage: string;
  taskId: string;
  userApproved: boolean;
}

interface RenderedRouteOutput {
  fallbackCode: string;
  materializationComplete: boolean;
  materializationRequested: boolean;
  materialized: boolean;
  materializedDocsCount: number;
  omittedDocsCount: number;
  output: string;
  requestedOutputChars: number;
  warning: string;
}

interface MicroScope {
  microBrief: (MicroBriefSummary & { briefHash: string }) | null;
  microGuard: (MicroGuardSummary & {
    files: string[];
    repositoryId: string;
  }) | null;
  microRepository: RepositoryBinding | null;
}

interface MicroScopeOptions {
  briefFile?: string;
  patchFile?: string;
  patchStdin?: boolean;
  repository?: string;
  route: string;
  runId: string;
  stage: string;
}

interface RouteLineageEvent {
  result: string;
  route: string;
  runId: string;
  stage?: string;
}

const usage = [
  'Usage:',
  '  agent-workflow route --route <route> --stage <stage> --entry <entry>',
  '    [--intent <intent> <structured fact flags>]',
  '    [--skill <name>] [--reference <path#heading>] [--risk <flag>]',
  '    [--format text|json]',
  '    [--run-id <anonymous-id>] [--parent-run-id <anonymous-id>] [--task <task-id>]',
  '    [--brief-file <workspace-relative-json>]',
  '    [--patch-stdin | --patch-file <workspace-relative-patch>]',
  '    [--repository <workspace-relative-repository>]',
  '    [--user-approved]',
  '    [--materialize-context] [--no-log]',
  '',
  '  agent-workflow route --list',
].join('\n');

export const readArguments = (args: string[]): RouteOptions => {
  const options: RouteOptions = {
    classificationFacts: null,
    entry: '',
    format: 'text',
    level: null,
    list: false,
    materializeContext: false,
    briefFile: '',
    patchFile: '',
    patchStdin: false,
    noLog: false,
    parentRunId: '',
    references: [],
    repository: '',
    riskFlags: [],
    route: '',
    runId: '',
    skills: [],
    stage: '',
    taskId: '',
    userApproved: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) {
      continue;
    }
    if (argument === '--list') {
      options.list = true;
      continue;
    }
    if (['--materialize-context', '--materialize'].includes(argument)) {
      options.materializeContext = true;
      continue;
    }
    if (argument === '--no-log') {
      options.noLog = true;
      continue;
    }
    if (argument === '--level') {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--level 必须提供非负整数');
      }
      options.level = value;
      index += 1;
      continue;
    }
    if (argument === '--patch-stdin') {
      options.patchStdin = true;
      continue;
    }
    if (argument === '--user-approved') {
      options.userApproved = true;
      continue;
    }
    if ([
      '--route',
      '--stage',
      '--entry',
      '--skill',
      '--risk',
      '--reference',
      '--repository',
      '--format',
      '--brief-file',
      '--patch-file',
      '--parent-run-id',
      '--run-id',
      '--task',
    ].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} 缺少值`);
      }
      if (argument === '--skill') {
        options.skills.push(value);
      } else if (argument === '--reference') {
        options.references.push(value);
      } else if (argument === '--risk') {
        options.riskFlags.push(value);
      } else if (argument === '--run-id') {
        options.runId = value;
      } else if (argument === '--parent-run-id') {
        options.parentRunId = value;
      } else if (argument === '--brief-file') {
        options.briefFile = value;
      } else if (argument === '--patch-file') {
        options.patchFile = value;
      } else if (argument === '--task') {
        options.taskId = value;
      } else {
        const scalarKey = argument.slice(2) as
          'entry' | 'format' | 'repository' | 'route' | 'stage';
        if (scalarKey === 'format') {
          if (value !== 'json' && value !== 'text') {
            throw new Error('--format 只支持 text 或 json');
          }
          options.format = value;
        } else {
          options[scalarKey] = value;
        }
      }
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }

  return options;
};

export const readRouteArguments = (args: string[]): RouteOptions => {
  const { facts, remainingArgs } = extractRouteClassificationArgs(args);
  const options = readArguments(remainingArgs);
  if (facts) {
    options.classificationFacts = facts;
    options.entry = facts.entry || '';
    options.riskFlags = facts.riskFlags ?? [];
    // `--level` is consumed as a fact, so mirror it onto the options the gate reads.
    if (typeof facts.level === 'number') {
      options.level = facts.level;
    }
  } else {
    options.classificationFacts = null;
  }
  return options;
};

const classifyRouteSelection = (
  options: RouteOptions,
): RouteClassification | null => {
  if (!options.classificationFacts) {
    if (loadRoutes().routes[options.route]?.factClassificationRequired) {
      throw new Error(
        'level-1 必须在 workflow:route 中提供 --intent 和全部 Gate 事实',
      );
    }
    return null;
  }
  const classification = classifyRouteFacts(options.classificationFacts);
  if (classification.route !== options.route) {
    throw new Error(
      `结构化事实判定 Route 为 ${classification.route}/${classification.stage}，` +
      `不能生成 ${options.route}/${options.stage}`,
    );
  }
  return classification;
};

export const guardMicroChangeScope = (
  options: MicroScopeOptions,
  classification: RouteClassification | null,
  allowNewRun: boolean,
  events: WorkflowEvent[],
): MicroScope => {
  if (!loadRoutes().routes[options.route]?.stagePaths) {
    if (options.briefFile || options.patchFile ||
        options.patchStdin || options.repository) {
      throw new Error('当前 Route/Stage 不接受 Brief 或 patch 参数');
    }
    return {
      microBrief: null,
      microGuard: null,
      microRepository: null,
    };
  }
  const requiresGuard = MICRO_GUARD_STAGES.has(options.stage);
  const requiresBrief = MICRO_BRIEF_STAGES.has(options.stage);
  const repositoryGuard = guardMicroRepository(options.repository ?? '', {
    required: false,
  });
  const patchInputCount = Number(options.patchStdin) +
    Number(Boolean(options.patchFile));
  if (!requiresGuard) {
    if (patchInputCount > 0) {
      throw new Error('当前 Route/Stage 不接受 level-1 实际 patch 参数');
    }
  } else if (patchInputCount !== 1) {
    throw new Error(
      `${options.route}/${options.stage} 必须且只能使用 ` +
      '--patch-stdin 或 --patch-file 提交任务 patch',
    );
  }
  if (requiresGuard && !repositoryGuard) {
    throw new Error(
      `Change 范围检查：${options.route}/${options.stage} ` +
      '必须使用 --repository ' +
      '绑定实际 patch 所属仓库',
    );
  }
  if (!requiresBrief && options.briefFile) {
    throw new Error('当前 Route/Stage 不接受 --brief-file');
  }
  if (requiresBrief && !options.briefFile) {
    throw new Error(
      `${options.route}/${options.stage} 必须使用 --brief-file ` +
      '提交 G/AC/OOS/C/VT 追踪契约',
    );
  }
  if (!classification) {
    throw new Error('level-1 缺少结构化事实分类');
  }
  const patch = options.patchStdin
    ? readFileSync(0, 'utf8')
    : options.patchFile
      ? readWorkflowInputFile(options.patchFile, {
        allowedPrefix: `${workflowRelativePath('runtimeRoot', 'patches')}/`,
        label: 'Micro patch 文件',
        maxBytes: 200 * 1024,
      }).content
      : '';
  const microGuard = requiresGuard
    ? guardMicroChangePatch({
      patch,
      repository: repositoryGuard?.repository ?? '',
    })
    : null;
  const microBrief = requiresBrief
    ? guardMicroBriefFile({
      briefFile: options.briefFile ?? '',
      patchFiles: microGuard?.files || [],
      repository: repositoryGuard?.repository || '',
      stage: options.stage,
    })
    : null;
  validateMicroChangeRun({
    allowNewRun,
    briefPlanHash: microBrief?.planHash ?? '',
    changeType: classification.changeType,
    events,
    patchHash: microGuard?.patchHash ?? '',
    repositoryId: microGuard?.repositoryId ?? '',
    route: options.route,
    runId: options.runId,
    sourceHash: microGuard?.sourceHash ?? '',
    stage: options.stage,
  });
  return {
    microBrief,
    microGuard,
    microRepository: repositoryGuard
      ? {
        repository: repositoryGuard.repository,
        repositoryId: repositoryGuard.repositoryId,
      }
      : null,
  };
};

export const isInitialRouteStage = (
  options: Pick<RouteOptions, 'route' | 'stage'>,
  classification: RouteClassification | null,
): boolean => {
  if (classification?.stage) {
    return options.stage === classification.stage;
  }
  const route = loadRoutes().routes[options.route];
  return options.stage === Object.keys(route?.stages || {})[0];
};

export const validateImplementationApproval = ({
  continuation = false,
  route,
  stage,
  userApproved = false,
}: { continuation?: boolean; route: string; stage: string; userApproved?: boolean }): void => {
  const requiresApproval = stage === 'implement' &&
    loadRoutes().routes[route]?.implementationApprovalRequired === true;
  if (requiresApproval && !userApproved) {
    throw new Error(
      continuation
        ? 'Implementation Approval Gate: 批准记录与当前计划一致，但仍需当前会话用户确认继续；' +
          '确认后追加 --user-approved'
        : 'Implementation Approval Gate: 实现前必须先向用户展示问题定位/需求依据、' +
          '计划修改点和验证项并停止；仅在用户当前会话明确批准后，才能使用 ' +
          '--user-approved 进入 Implement',
    );
  }
  if (!requiresApproval && userApproved) {
    throw new Error(
      'Implementation Approval Gate: --user-approved 只允许用于 ' +
      'level-1 或 level-2 的 implement 阶段',
    );
  }
};

/**
 * Grades are declared, not inferred: only a Route that declares `requiredLevel`
 * accepts `--level`, and it accepts exactly that value. Fact consistency between
 * the declared grade and the derived grade is enforced during classification.
 */
export const guardLevelDeclaration = (
  options: Pick<RouteOptions, 'level' | 'route'>,
): void => {
  const requiredLevel = loadRoutes().routes[options.route]?.requiredLevel;
  if (options.level === null) {
    if (requiredLevel !== undefined) {
      throw new Error(
        `等级声明 Gate: Route ${options.route} 必须显式声明 --level ${requiredLevel}；` +
        '缺少声明的调用一律拒绝',
      );
    }
    return;
  }
  if (requiredLevel !== options.level) {
    throw new Error(
      `等级声明 Gate: --level ${options.level} 只允许用于声明 ` +
      `requiredLevel ${options.level} 的 Route；当前 Route ${options.route} ` +
      (requiredLevel === undefined ? '未声明等级门禁' : `要求 --level ${requiredLevel}`),
    );
  }
};

export const validateRunLineage = ({
  createdRunId,
  events,
  initialRouteStage,
  initialStage,
  parentRunId = '',
  route,
  runId,
}: {
  createdRunId: boolean;
  events: RouteLineageEvent[];
  initialRouteStage: string;
  initialStage: boolean;
  parentRunId?: string;
  route: string;
  runId: string;
}): void => {
  const successfulEvents = events.filter((event) => event.result === 'success');
  const runEvents = successfulEvents.filter((event) => event.runId === runId);
  const runRoutes = new Set(runEvents.map((event) => event.route));
  if (runRoutes.size > 1 || (runRoutes.size === 1 && !runRoutes.has(route))) {
    throw new Error(
      `Run Route Gate: ${runId} 已绑定 ${[...runRoutes].join(', ')}；` +
      '切换 Route 时去掉 --run-id，并用 --parent-run-id 关联原 Run',
    );
  }
  if (parentRunId && (!initialStage || !createdRunId)) {
    throw new Error(
      'Run Route Gate: --parent-run-id 只允许在新 Route 首阶段创建新 Run 时使用',
    );
  }
  if (!createdRunId && runEvents.length === 0) {
    throw new Error(`Run Continuity Gate: ${runId} 不存在或没有成功事件`);
  }
  if (!initialStage && !runEvents.some((event) =>
    event.route === route && event.stage === initialRouteStage)) {
    throw new Error(
      `Run Continuity Gate: ${runId} 缺少首阶段 ${route}/${initialRouteStage} 的成功事件`,
    );
  }
  if (!parentRunId) {
    return;
  }
  if (parentRunId === runId) {
    throw new Error('Run Route Gate: Parent Run 不能与新 Run 相同');
  }
  const parentRoutes = new Set(successfulEvents
    .filter((event) => event.runId === parentRunId)
    .map((event) => event.route));
  if (parentRoutes.size === 0) {
    throw new Error('Run Route Gate: Parent Run 不存在或没有成功事件');
  }
  if (parentRoutes.size !== 1) {
    throw new Error('Run Route Gate: Parent Run 的 Route 归属不唯一');
  }
  if (parentRoutes.has(route)) {
    throw new Error('Run Route Gate: --parent-run-id 只用于切换 Route');
  }
};

const listRoutes = (): void => {
  const config = loadRoutes();
  Object.entries(config.routes).forEach(([routeName, route]) => {
    process.stdout.write(
      `${routeName}: entries=${route.entryModes.join(',')} ` +
      `stages=${Object.keys(route.stages).join(',')}\n`,
    );
  });
};

const attemptedValue = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : '';
  return value && !value.startsWith('--') ? value : '';
};

const recordSafely = (
  event: Parameters<typeof recordRouteEvent>[0],
  disabled: boolean,
  { required = false }: { required?: boolean } = {},
): void => {
  if (disabled) {
    if (required) {
      throw new Error('Change Run Gate: 等级路由不允许使用 --no-log');
    }
    return;
  }
  try {
    recordRouteEvent(event);
  } catch (error: unknown) {
    if (required) {
      throw new Error(
        `Change Run Gate: 无法写入连续性日志（${errorMessage(error)}）`,
      );
    }
    process.stderr.write('WARN: 匿名化路由日志写入失败，路由结果不受影响。\n');
  }
};

export const renderRouteOutput = (
  packet: RoutePacket,
  {
    format = 'text',
    materializeContext = false,
  }: { format?: 'json' | 'text'; materializeContext?: boolean } = {},
): RenderedRouteOutput => {
  const plainOutput = () => format === 'json'
    ? JSON.stringify(packet, null, 2)
    : formatRoutePacket(packet);
  if (!materializeContext) {
    return {
      fallbackCode: '',
      materializationComplete: false,
      materializationRequested: false,
      materialized: false,
      materializedDocsCount: 0,
      omittedDocsCount: 0,
      output: plainOutput(),
      requestedOutputChars: 0,
      warning: '',
    };
  }

  try {
    const materialized = materializeRoutePacket(packet, format);
    return {
      fallbackCode: materialized.complete ? '' : 'partial-materialize',
      materializationComplete: materialized.complete,
      materializationRequested: true,
      materialized: materialized.materializedDocs.length > 0,
      materializedDocsCount: materialized.materializedDocs.length,
      omittedDocsCount: materialized.omittedDocs.length,
      output: materialized.output,
      requestedOutputChars: materialized.requestedOutputChars,
      warning: '',
    };
  } catch (error: unknown) {
    if (classifyRouteError(error) !== 'tool-output-exceeded') {
      throw error;
    }
    return {
      fallbackCode: 'tool-output-exceeded',
      materializationComplete: false,
      materializationRequested: true,
      materialized: false,
      materializedDocsCount: 0,
      omittedDocsCount: packet.materializeDocs.length,
      output: plainOutput(),
      requestedOutputChars: 0,
      warning:
        `${errorMessage(error)}；已自动回退为普通 Route Packet，请按白名单读取`,
    };
  }
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  const startedAt = Date.now();
  let options: RouteOptions = {
    classificationFacts: null,
    entry: attemptedValue(args, '--entry'),
    format: 'text',
    level: null,
    list: args.includes('--list'),
    materializeContext:
      args.includes('--materialize-context') || args.includes('--materialize'),
    briefFile: attemptedValue(args, '--brief-file'),
    patchFile: attemptedValue(args, '--patch-file'),
    patchStdin: args.includes('--patch-stdin'),
    noLog: args.includes('--no-log'),
    parentRunId: attemptedValue(args, '--parent-run-id'),
    references: [],
    repository: attemptedValue(args, '--repository'),
    riskFlags: [],
    route: attemptedValue(args, '--route'),
    runId: attemptedValue(args, '--run-id'),
    skills: [],
    stage: attemptedValue(args, '--stage'),
    taskId: attemptedValue(args, '--task'),
    userApproved: args.includes('--user-approved'),
  };
  let packet: RoutePacket | undefined;
  let classification: RouteClassification | null = null;
  let createdRunId = false;
  let outputChars = 0;
  let rendered: RenderedRouteOutput = {
    fallbackCode: '',
    materializationComplete: false,
    materializationRequested: options.materializeContext,
    materialized: false,
    materializedDocsCount: 0,
    omittedDocsCount: 0,
    output: '',
    requestedOutputChars: 0,
    warning: '',
  };

  try {
    options = readRouteArguments(args);
    if (options.list) {
      listRoutes();
      return 0;
    }
    if ((!options.route && options.level === null) || !options.stage || !options.entry) {
      throw new Error('必须提供 --route（或用 --level 选择等级 Route）、--stage 和 --entry');
    }
    if (!['text', 'json'].includes(options.format)) {
      throw new Error('--format 只支持 text 或 json');
    }
    if (options.runId && !isValidRunId(options.runId)) {
      throw new Error('--run-id 必须符合 run-<16-64 位小写字母或数字>');
    }
    if (options.parentRunId && !isValidRunId(options.parentRunId)) {
      throw new Error('--parent-run-id 必须符合 run-<16-64 位小写字母或数字>');
    }
    if (options.runId && options.parentRunId) {
      throw new Error('--run-id 与 --parent-run-id 不能同时使用');
    }

    if (!options.route) {
      if (options.level === null) throw new Error('必须提供 --route 或 --level');
      const matched = Object.entries(loadRoutes().routes)
        .find(([, route]) => route.requiredLevel === options.level);
      if (!matched) throw new Error(`没有声明 requiredLevel ${options.level} 的 Route`);
      options.route = matched[0];
    }
    classification = classifyRouteSelection(options);
    guardLevelDeclaration(options);
    const published = options.taskId ? requirePublishedTask(taskPath(options.taskId), true) : null;
    const continuation = Boolean(published && options.stage === 'implement' &&
      hasTaskApproval(taskPath(options.taskId), published));
    validateImplementationApproval({ ...options, continuation, userApproved: options.userApproved });
    const taskState = guardRouteTask(options);
    const initialStage = isInitialRouteStage(options, classification);
    const initialRouteStage = classification?.stage ||
      Object.keys(loadRoutes().routes[options.route]?.stages || {})[0] || '';
    if (!options.runId) {
      if (taskState?.runId) {
        options.runId = taskState.runId;
      } else if (initialStage) {
        options.runId = createRunId();
        createdRunId = true;
      } else {
        throw new Error(
          `${options.route}/${options.stage} 必须复用首阶段 Packet 的 --run-id`,
        );
      }
    }
    const loaded = filterRouteEventsByVersion(loadRouteEvents({ days: 90 }));
    if (!published) validateRunLineage({
      createdRunId,
      events: loaded.events,
      initialRouteStage,
      initialStage,
      parentRunId: options.parentRunId,
      route: options.route,
      runId: options.runId,
    });
    const { microBrief, microGuard, microRepository } = guardMicroChangeScope(
      options,
      classification,
      createdRunId,
      loaded.events,
    );
    packet = buildRoutePacket({
      ...options,
      classification,
      microBrief,
      microGuard,
      microRepository,
    });
    rendered = renderRouteOutput(packet, {
      format: options.format,
      materializeContext: options.materializeContext,
    });
    const output = rendered.output;
    outputChars = Array.from(`${output}\n`).length;
    recordSafely({
      budgetChars: packet.budgetChars,
      changeType: packet.changeType,
      durationMs: Date.now() - startedAt,
      entry: packet.entry,
      fallbackCode: rendered.fallbackCode,
      loadedChars: packet.loadedChars,
      materializationComplete: rendered.materializationComplete,
      materializationRequested: rendered.materializationRequested,
      materialized: rendered.materialized,
      materializedDocsCount: rendered.materializedDocsCount,
      microBriefHash: packet.microBrief?.briefHash,
      microBriefPlanHash: packet.microBrief?.planHash,
      microPatchHash: packet.microGuard?.patchHash,
      microRepositoryId: packet.microGuard?.repositoryId,
      microSourceHash: packet.microGuard?.sourceHash,
      omittedDocsCount: rendered.omittedDocsCount,
      outputChars,
      parentRunId: options.parentRunId,
      implementationApproved: options.userApproved,
      result: 'success',
      resultKind: 'allowed',
      riskFlags: packet.decision.riskFlags,
      route: packet.route,
      routesVersion: packet.routesVersion,
      runId: options.runId,
      skills: options.skills,
      stage: packet.stage,
      timestamp: new Date().toISOString(),
      requestedOutputChars: rendered.requestedOutputChars,
      usedChars: packet.usedChars,
    }, options.noLog, {
      required: loadRoutes().routes[packet.route]?.patchLogRequired === true,
    });
    process.stdout.write(`${output}\n`);
    if (rendered.warning) {
      process.stderr.write(`WARN: ${rendered.warning}。\n`);
    }
    return 0;
  } catch (error: unknown) {
    recordSafely({
      budgetChars: packet?.budgetChars,
      changeType: classification?.changeType,
      durationMs: Date.now() - startedAt,
      entry: options.entry,
      errorCode: classifyRouteError(error),
      fallbackCode: rendered.fallbackCode,
      loadedChars: packet?.loadedChars,
      materializationComplete: rendered.materializationComplete,
      materializationRequested: rendered.materializationRequested,
      materialized: rendered.materialized,
      materializedDocsCount: rendered.materializedDocsCount,
      omittedDocsCount: rendered.omittedDocsCount,
      outputChars,
      parentRunId: options.parentRunId,
      result: 'error',
      resultKind: classifyRouteResult(error),
      riskFlags: options.riskFlags,
      route: options.route,
      routesVersion: packet?.routesVersion,
      runId: options.runId,
      skills: options.skills,
      stage: options.stage,
      timestamp: new Date().toISOString(),
      requestedOutputChars: rendered.requestedOutputChars,
      usedChars: packet?.usedChars,
    }, options.noLog || options.list);
    process.stderr.write(`工作流路由失败：${errorMessage(error)}\n${usage}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
