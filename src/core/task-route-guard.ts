import {
  existsSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { loadWorkflowPaths } from '../config/workflow-config.js';
import {
  loadRoutes,
} from './context-budget.js';
import {
  readManifestModel,
  validateManifestTaskFlow,
} from './task-lifecycle.js';
import { validateTaskArtifactsById } from '../validators/check-task-artifacts.js';
import type { RoutesConfig } from '../types/contracts.js';
import { errorMessage } from '../types/guards.js';

type TaskArtifacts = Record<string, string | null | undefined>;

interface RouteTaskOptions {
  entry: string;
  route: string;
  runId: string;
  stage: string;
  taskId?: string;
}

interface RouteTaskState {
  currentStage: string;
  runId: string;
  status: string;
  taskId: string;
}

const defaultTasksRoot = loadWorkflowPaths().tasksRoot;
const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const taskGateError = (message: string): Error =>
  new Error(`Task Gate: ${message}`);

const readSpecStatus = (content: string): string => {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return (frontmatter?.[1] ?? '').match(/^status:\s*(\S+)\s*$/m)?.[1] ?? '';
};

const readArtifact = (taskDirectory: string, fileName: string): string | null => {
  const filePath = path.join(taskDirectory, fileName);
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
};

export const validateRouteTaskState = ({
  artifacts = {},
  entry = '',
  manifestContent = '',
  route = '',
  runId = '',
  stage = '',
  taskId = '',
}: {
  artifacts?: TaskArtifacts;
  entry?: string;
  manifestContent?: string;
  route?: string;
  runId?: string;
  stage?: string;
  taskId?: string;
}, config: RoutesConfig = loadRoutes()): RouteTaskState | null => {
  const routeConfig = config.routes[route];
  if (!routeConfig?.taskFlow) {
    if (taskId) {
      throw taskGateError(`Route ${route} 未定义 taskFlow，不能使用 --task`);
    }
    return null;
  }

  const taskRequired = (routeConfig.taskRequiredStages || []).includes(stage);
  if (!taskId) {
    if (taskRequired) {
      throw taskGateError(
        `${route}/${stage} 必须提供 --task；` +
        '先在 spec-plan 生成并确认最小 Spec 包，再推进 manifest 当前阶段',
      );
    }
    return null;
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw taskGateError('任务 ID 只能包含小写字母、数字和连字符');
  }
  if (!manifestContent) {
    throw taskGateError(`任务 manifest 不存在：${taskId}`);
  }

  let model;
  try {
    model = readManifestModel(manifestContent);
  } catch (error: unknown) {
    throw taskGateError(`manifest 无法解析：${errorMessage(error)}`);
  }
  const lifecycleErrors = validateManifestTaskFlow(model, config);
  if (lifecycleErrors.length > 0) {
    throw taskGateError(`manifest 生命周期无效：${lifecycleErrors[0]}`);
  }
  if (model.taskId !== taskId) {
    throw taskGateError(
      `任务目录 ${taskId} 与 manifest Task ID ${model.taskId || '空'} 不一致`,
    );
  }
  if (model.routeId !== route) {
    throw taskGateError(
      `manifest Route ID 为 ${model.routeId || '空'}，不能用于 ${route}`,
    );
  }
  if (runId && model.runId !== runId) {
    throw taskGateError('命令 --run-id 与 manifest Run ID 不一致');
  }
  const manifestEntry = model.entryMode;
  if (!manifestEntry) {
    throw taskGateError('manifest Source Record 缺少 Entry Mode');
  }
  if (manifestEntry !== entry) {
    throw taskGateError(
      `命令 Entry ${entry} 与 manifest Entry Mode ${manifestEntry} 不一致`,
    );
  }

  const expectedStages = routeConfig.stages?.[stage]?.taskStages;
  if (!Array.isArray(expectedStages) || expectedStages.length === 0) {
    throw taskGateError(`Route ${route}/${stage} 未登记 taskStages`);
  }
  const expectsCompleteTask = expectedStages.includes('complete');
  if (expectsCompleteTask && model.status !== 'complete') {
    throw taskGateError(
      `运行阶段 ${stage} 要求任务状态为 complete，当前为 ${model.status}`,
    );
  }
  if (!expectsCompleteTask && !expectedStages.includes(model.currentStage)) {
    throw taskGateError(
      `运行阶段 ${stage} 要求 manifest Current Stage 为 ` +
      `${expectedStages.join(' 或 ')}，当前为 ${model.currentStage}`,
    );
  }
  if (model.status === 'blocked') {
    throw taskGateError('任务处于 blocked；先补齐证据并执行 workflow:task resume');
  }
  if (taskRequired && model.status !== 'in_progress') {
    throw taskGateError(
      `${stage} 要求任务状态为 in_progress，当前为 ${model.status}`,
    );
  }

  if (route === 'standard-change' && taskRequired) {
    ['source.md', 'intake.md', 'spec.md', 'plan.md'].forEach((fileName) => {
      const artifact = artifacts[fileName];
      if (typeof artifact !== 'string' || !artifact.trim()) {
        throw taskGateError(`标准实施前缺少或未填写最小 Spec 包文件 ${fileName}`);
      }
    });
    const specContent = artifacts['spec.md'];
    const specStatus = readSpecStatus(typeof specContent === 'string' ? specContent : '');
    if (specStatus !== 'confirmed') {
      throw taskGateError(
        `标准实施前 spec.md status 必须为 confirmed，当前为 ${specStatus || '空'}`,
      );
    }
  }

  return {
    currentStage: model.currentStage,
    runId: model.runId,
    status: model.status,
    taskId,
  };
};

export const guardRouteTask = (
  options: RouteTaskOptions,
  {
    tasksRoot = defaultTasksRoot,
  }: { tasksRoot?: string } = {},
): RouteTaskState | null => {
  const taskId = options.taskId || '';
  const taskDirectory = taskId && TASK_ID_PATTERN.test(taskId)
    ? path.join(tasksRoot, taskId)
    : '';
  const taskState = validateRouteTaskState({
    artifacts: taskDirectory
      ? {
        'intake.md': readArtifact(taskDirectory, 'intake.md'),
        'source.md': readArtifact(taskDirectory, 'source.md'),
        'spec.md': readArtifact(taskDirectory, 'spec.md'),
      }
      : {},
    entry: options.entry,
    manifestContent: taskDirectory
      ? readArtifact(taskDirectory, 'manifest.md') ?? ''
      : '',
    route: options.route,
    runId: options.runId,
    stage: options.stage,
    taskId,
  });
  if (taskState) {
    const artifactErrors = validateTaskArtifactsById(taskId, {
      root: tasksRoot,
    });
    if (artifactErrors.length > 0) {
      throw taskGateError(`任务产物检查失败：${artifactErrors[0]}`);
    }
  }
  return taskState;
};
