import {
  existsSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadWorkflowPaths } from '../config/workflow-config.js';
import { loadRoutes } from './context-budget.js';
import { main as routeMain } from './route.js';
import {
  readManifestModel,
  validateManifestTaskFlow,
} from './task-lifecycle.js';
import type { RoutesConfig } from '../types/contracts.js';
import type { ManifestModel } from './task-lifecycle.js';
import { errorMessage } from '../types/guards.js';

interface DerivedRoute {
  entry: string;
  route: string;
  runId: string;
  stage: string;
  taskId: string;
}

const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORBIDDEN_OVERRIDES = new Set([
  '--entry',
  '--intent',
  '--parent-run-id',
  '--route',
  '--run-id',
  '--stage',
]);

/** Keeps task-owned route identity immutable while forwarding ordinary Route flags. */
export const readNextArguments = (args: string[]): {
  remainingArgs: string[];
  taskId: string;
} => {
  if (args.filter((argument) => argument === '--task').length !== 1) {
    throw new Error('workflow:next 必须且只能提供一个 --task <task-id>');
  }
  const taskIndex = args.indexOf('--task');
  const taskId = taskIndex >= 0 ? args[taskIndex + 1] : '';
  if (!taskId || taskId.startsWith('--')) {
    throw new Error('workflow:next 必须且只能提供一个 --task <task-id>');
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error('Task ID 只能包含小写字母、数字和连字符');
  }
  const remainingArgs = args.filter((_, index) =>
    index !== taskIndex && index !== taskIndex + 1);
  const forbidden = remainingArgs.find((argument) => FORBIDDEN_OVERRIDES.has(argument));
  if (forbidden) {
    throw new Error(`${forbidden} 由 manifest 推导，workflow:next 不接受覆盖`);
  }
  return {
    remainingArgs,
    taskId,
  };
};

export const deriveNextRoute = (
  taskId: string,
  {
    config = loadRoutes(),
    tasksRoot = loadWorkflowPaths().tasksRoot,
  }: { config?: RoutesConfig; tasksRoot?: string } = {},
): DerivedRoute => {
  const manifestPath = path.join(tasksRoot, taskId, 'manifest.md');
  if (!existsSync(manifestPath)) {
    throw new Error(`任务 manifest 不存在：${taskId}`);
  }
  const manifestContent = readFileSync(manifestPath, 'utf8');
  const model = readManifestModel(manifestContent);
  const lifecycleErrors = validateManifestTaskFlow(model, config);
  if (lifecycleErrors.length > 0) {
    throw new Error(`manifest 生命周期无效：${lifecycleErrors[0]}`);
  }
  if (model.status === 'complete' || model.currentStage === 'complete') {
    throw new Error(`任务 ${taskId} 已完成，没有下一 Route Packet`);
  }
  if (model.status === 'blocked') {
    throw new Error('任务处于 blocked；先补齐证据并执行 workflow:task resume');
  }

  return deriveNextRouteFromModel(model, taskId, config);
};

export const deriveNextRouteFromModel = (
  model: Pick<ManifestModel, 'currentStage' | 'entryMode' | 'routeId' | 'runId'>,
  taskId: string,
  config: RoutesConfig = loadRoutes(),
): DerivedRoute => {
  const route = config.routes[model.routeId];
  const stages = Object.entries(route?.stages || {})
    .filter(([, stage]) => stage.taskStages?.includes(model.currentStage))
    .map(([stageName]) => stageName);
  if (stages.length !== 1) {
    throw new Error(
      `Current Stage ${model.currentStage || '空'} 必须唯一映射到 Route Stage，` +
      `实际匹配 ${stages.length} 个`,
    );
  }
  if (!model.entryMode) {
    throw new Error('manifest Source Record 缺少 Entry Mode');
  }
  const stage = stages[0];
  if (!stage) {
    throw new Error(`Current Stage ${model.currentStage} 缺少 Route Stage 映射`);
  }
  return {
    entry: model.entryMode,
    route: model.routeId,
    runId: model.runId,
    stage,
    taskId,
  };
};

/** Builds the canonical Route CLI arguments from validated manifest state. */
export const buildNextRouteArguments = (
  derived: DerivedRoute,
  remainingArgs: string[] = [],
): string[] => [
  '--route', derived.route,
  '--stage', derived.stage,
  '--entry', derived.entry,
  '--task', derived.taskId,
  ...remainingArgs,
];

export const main = (args: string[] = process.argv.slice(2)): number => {
  try {
    const { remainingArgs, taskId } = readNextArguments(args);
    const derived = deriveNextRoute(taskId);
    return routeMain(buildNextRouteArguments(derived, remainingArgs));
  } catch (error: unknown) {
    process.stderr.write(`ERROR: ${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  process.exitCode = main();
}
