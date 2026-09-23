import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadWorkflowPaths } from '../config/workflow-config.js';
import { validateTaskArtifactsById } from '../validators/check-task-artifacts.js';
import {
  readManifestModel,
  transitionManifestContent,
} from './task-lifecycle.js';
import type {
  TaskTransitionCommand,
  TaskTransitionOptions,
} from './task-lifecycle.js';
import { recordWorkflowEvent } from './runtime-log.js';
import { errorMessage } from '../types/guards.js';
import { selectTask, requireSelectedTask } from './task-selection.js';
import { main as routeMain } from './route.js';
import { persistentCommands, runPersistentCommand, persistentExitGate, reopenPlan, approvedPlanUnchanged, diagnosePersistentTask } from './task-persistence.js';
import { persistentTask, requirePublishedTask, publishCheckpoint } from './task-checkpoint.js';
import { replaceFileAtomically, withManifestLock } from './task-files.js';
export { replaceFileAtomically, withManifestLock } from './task-files.js';
import {
  checkHandoff, collectTaskSummary, prepareHandoff, readSummarySection,
  renderTaskSummary, taskDirectoryFor,
} from './task-handoff.js';

interface TaskUpdateOptions extends Omit<TaskTransitionOptions, 'command'> {
  expectedLastUpdated?: string;
}

type ArtifactValidator = (
  taskId: string,
  options: { manifestContent?: string | null },
) => string[];

const tasksRoot = loadWorkflowPaths().tasksRoot;
const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hashContent = (content: string): string => createHash('sha256')
  .update(content, 'utf8')
  .digest('hex');
const toIdentifier = (value: string): string => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || 'unknown';

const readArgumentValue = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] ?? '' : '';
  return value.startsWith('--') ? '' : value;
};

export const validateTaskUpdateArtifacts = (
  taskId: string,
  validate: ArtifactValidator = validateTaskArtifactsById as ArtifactValidator,
  {
    manifestContent = null,
  }: { manifestContent?: string | null } = {},
): void => {
  const artifactErrors = validate(taskId, { manifestContent });
  if (artifactErrors.length > 0) {
    throw new Error(`任务产物检查未通过：${artifactErrors[0]}`);
  }
};

const updateTask = (
  taskId: string,
  command: TaskTransitionCommand,
  transitionOptions: TaskUpdateOptions = {},
): void => {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error('任务 ID 只能包含小写字母、数字和连字符');
  }

  const manifestPath = path.join(tasksRoot, taskId, 'manifest.md');
  if (!existsSync(manifestPath)) {
    throw new Error(`任务 manifest 不存在：${taskId}`);
  }

  const { originalModel, updatedModel } = withManifestLock(
    manifestPath,
    () => {
      const originalContent = readFileSync(manifestPath, 'utf8');
      const currentModel = readManifestModel(originalContent);
      const checkpoint = requirePublishedTask(path.dirname(manifestPath));
      if (checkpoint && transitionOptions.expectedLastUpdated !== currentModel.lastUpdated) {
        throw new Error(`持久任务更新必须提供 --expected-last-updated ${currentModel.lastUpdated}`);
      }
      if (transitionOptions.expectedLastUpdated &&
          transitionOptions.expectedLastUpdated !== currentModel.lastUpdated) {
        throw new Error(
          `manifest Last Updated 已变化，期望 ` +
          `${transitionOptions.expectedLastUpdated}，当前 ${currentModel.lastUpdated}`,
        );
      }
      persistentExitGate(path.dirname(manifestPath), command);
      // A recorded approval only proves scope applicability; entering Implement still
      // requires the current session's confirmation, so never infer it from the file.
      const continuation = Boolean(checkpoint && transitionOptions.to === 'Implement' &&
        approvedPlanUnchanged(path.dirname(manifestPath)));
      if (transitionOptions.userApproved && transitionOptions.to === 'Implement' && checkpoint &&
          !(transitionOptions.approvalSource || transitionOptions.evidence || transitionOptions.reason || '').trim()) {
        throw new Error('持久任务的实施批准必须提供 --approval-source（当前会话用户批准的依据），不能用占位文本代替');
      }
      const updatedContent = transitionManifestContent(
        originalContent,
        {
          ...transitionOptions,
          command,
          continuation,
          userApproved: Boolean(transitionOptions.userApproved),
        },
      );
      validateTaskUpdateArtifacts(
        taskId,
        validateTaskArtifactsById as ArtifactValidator,
        { manifestContent: updatedContent },
      );
      if (hashContent(readFileSync(manifestPath, 'utf8')) !==
          hashContent(originalContent)) {
        throw new Error('manifest 在更新期间被外部修改，已拒绝覆盖');
      }
      if (command === 'reopen') reopenPlan(path.dirname(manifestPath), transitionOptions.to ?? '');
      replaceFileAtomically(manifestPath, updatedContent);
      if (checkpoint) publishCheckpoint(path.dirname(manifestPath), {
        reason: transitionOptions.reason || transitionOptions.evidence || transitionOptions.action || command,
        previous: checkpoint,
        ...(transitionOptions.userApproved && transitionOptions.to === 'Implement'
          ? { approvalSource: transitionOptions.approvalSource || transitionOptions.evidence || transitionOptions.reason } : {}),
      });
      return {
        originalModel: currentModel,
        updatedModel: readManifestModel(updatedContent),
      };
    },
  );
  try {
    recordWorkflowEvent({
      eventType: command === 'complete' ? 'task-outcome' : 'stage-transition',
      fromStage: toIdentifier(originalModel.currentStage),
      implementationApproved: Boolean(
        transitionOptions.userApproved && updatedModel.currentStage === 'Implement',
      ),
      outcome: command === 'complete'
        ? 'complete'
        : updatedModel.status === 'blocked'
          ? 'blocked'
          : 'in-progress',
      result: 'success',
      route: updatedModel.routeId,
      runId: updatedModel.runId,
      stage: toIdentifier(updatedModel.currentStage),
      timestamp: new Date().toISOString(),
      toStage: toIdentifier(updatedModel.currentStage),
    });
  } catch {
    process.stderr.write('WARN: 匿名化任务状态日志写入失败，状态更新不受影响。\n');
  }

  process.stdout.write(`任务状态已更新并通过产物检查：${taskId} (${command})\n`);
};

const handoffTask = (taskId: string): void => {
  const directory = taskDirectoryFor(taskId);
  withManifestLock(path.join(directory, 'manifest.md'), () => {
    const legacyPath = path.join(directory, 'handoff-legacy.md');
    if (!existsSync(path.join(directory, 'handoff-state.json')) &&
        existsSync(path.join(directory, 'handoff.md')) && !existsSync(legacyPath)) {
      writeFileSync(legacyPath, readSummarySection(directory, 'handoff.md'), { encoding: 'utf8', flag: 'wx' });
    }
    const { document, state } = prepareHandoff(directory, taskId);
    // Publish the baseline last. Interrupted writes remain detectable on the next check.
    replaceFileAtomically(path.join(directory, 'handoff.md'), document);
    replaceFileAtomically(path.join(directory, 'handoff-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  });
  process.stdout.write(`交接包已生成：${taskId}\n`);
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  const [command] = args;
  let taskId = readArgumentValue(args, '--task');
  const transitionOptions = {
    action: readArgumentValue(args, '--action'),
    approvalSource: readArgumentValue(args, '--approval-source'),
    evidence: readArgumentValue(args, '--evidence'),
    expectedLastUpdated: readArgumentValue(args, '--expected-last-updated'),
    reason: readArgumentValue(args, '--reason'),
    stage: readArgumentValue(args, '--stage'),
    to: readArgumentValue(args, '--to'),
    userApproved: args.includes('--user-approved'),
  };

  try {
    if (args.filter((argument) => argument === '--task').length > 1 ||
        (args.includes('--task') && !taskId)) throw new Error('--task 必须且只能提供一个有效任务 ID');
    if (persistentCommands.has(command ?? '')) {
      if (!taskId) taskId = requireSelectedTask(selectTask()).taskId;
      return runPersistentCommand(command!, args, taskId);
    }
    if (['current', 'prepare', 'continue', 'summary', 'handoff', 'handoff-check'].includes(command ?? '')) {
      const selection = selectTask(taskId);
      if (command === 'current') {
        const format = readArgumentValue(args, '--format') || 'text';
        if (!['json', 'text'].includes(format)) throw new Error('--format must be text or json');
        if (format === 'json') {
          process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
          return selection.status === 'selected' ? 0 : 1;
        }
        const selected = requireSelectedTask(selection);
        process.stdout.write(`当前任务：${selected.taskId} | ${selected.currentStage} | ${selected.status}\n`);
        return 0;
      }
      taskId = requireSelectedTask(selection).taskId;
      if (command === 'prepare' || command === 'continue') {
        const selected = requireSelectedTask(selection);
        if (command === 'continue' && selected.status === 'complete') {
          process.stdout.write(`任务 ${taskId} 已完成，没有待续接阶段。\n`);
          return 0;
        }
        const route = command === 'prepare' ? 'task-handoff' : 'task-portable-resume';
        const stage = command === 'prepare' ? 'prepare' : 'resume';
        process.stdout.write(`已选择任务：${taskId} | ${selected.currentStage} | ${selected.status}\n`);
        const routeResult = routeMain(['--route', route, '--stage', stage, '--entry', selected.entry, '--materialize']);
        if (routeResult !== 0) return routeResult;
        const directory = taskDirectoryFor(taskId);
        process.stdout.write(`${renderTaskSummary(collectTaskSummary(directory, taskId))}\n`);
        if (command === 'continue' && persistentTask(directory)) {
          const diagnosis = diagnosePersistentTask(directory);
          process.stdout.write(`${JSON.stringify(diagnosis, null, 2)}\n`);
          return diagnosis.issues.length ? 1 : 0;
        }
        if (command === 'continue' && existsSync(path.join(directory, 'handoff-state.json'))) {
          const errors = checkHandoff(directory, taskId);
          if (errors.length) throw new Error(`交接需要核对：${errors.join('; ')}`);
        }
        process.stdout.write(command === 'prepare'
          ? `请由 Agent 更新任务 ${taskId} 的交接说明，执行 task handoff --task ${taskId} 和 handoff-check；无需用户填写文件或运行命令。\n`
          : `请按已加载上下文继续任务 ${taskId}；先处理阻塞或过期事实，再使用 next --task ${taskId}，不要重复已完成工作或自动解除 blocked。\n`);
        return 0;
      }
    }
    if (['start', 'advance', 'skip', 'block', 'resume', 'complete', 'reopen'].includes(command ?? '')) {
      updateTask(taskId, command as TaskTransitionCommand, transitionOptions);
      return 0;
    }
    if (command === 'summary') {
      const directory = taskDirectoryFor(taskId);
      const section = readArgumentValue(args, '--section');
      const format = readArgumentValue(args, '--format') || 'text';
      if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json');
      const summary = section ? null : collectTaskSummary(directory, taskId);
      process.stdout.write((section ? readSummarySection(directory, section)
        : format === 'json' ? JSON.stringify(summary, null, 2) : renderTaskSummary(summary!)) + '\n');
      return 0;
    }
    if (command === 'handoff') {
      handoffTask(taskId);
      return 0;
    }
    if (command === 'handoff-check') {
      const errors = checkHandoff(taskDirectoryFor(taskId), taskId);
      if (errors.length) throw new Error(errors.join('; '));
      process.stdout.write(`交接包检查通过：${taskId}\n`);
      return 0;
    }

    process.stderr.write(
      'Usage: agent-workflow task ' +
      '<current|prepare|continue|summary|handoff|handoff-check|init|status|checkpoint|item|migrate|verify-begin|verify-record> [--task <task-id>] ' +
      'or <start|advance|skip|block|resume|complete|reopen> --task <task-id> ' +
      '[--format text|json] [--section <file>#<section>] ' +
      '[--to <stage>] [--stage <stage>] [--action <text>] ' +
      '[--evidence <text>] [--reason <text>] ' +
      '[--user-approved] [--approval-source <text>] ' +
      '[--expected-last-updated <date-time>]\n',
    );
    return 1;
  } catch (error: unknown) {
    process.stderr.write(`任务状态更新失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
