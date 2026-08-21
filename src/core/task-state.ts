import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
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

interface TaskUpdateOptions extends Omit<TaskTransitionOptions, 'command'> {
  expectedLastUpdated?: string;
}

interface ManifestSection {
  body: string;
  bodyEnd: number;
  bodyStart: number;
}

type ArtifactValidator = (
  taskId: string,
  options: { manifestContent?: string | null },
) => string[];

const tasksRoot = loadWorkflowPaths().tasksRoot;
const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUMMARY_SECTION_LIMIT = 1600;
const SUMMARY_OUTPUT_LIMIT = 8000;
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

const findSection = (content: string, sectionName: string): ManifestSection => {
  const headingPattern = new RegExp(`^## ${sectionName}\\r?$`, 'm');
  const headingMatch = headingPattern.exec(content);
  if (!headingMatch) {
    throw new Error(`manifest 缺少 ${sectionName} 小节`);
  }

  const sectionBodyStart = headingMatch.index + headingMatch[0].length;
  const remainingContent = content.slice(sectionBodyStart);
  const nextHeadingOffset = remainingContent.search(/^##\s/m);
  const sectionBodyEnd = nextHeadingOffset < 0
    ? content.length
    : sectionBodyStart + nextHeadingOffset;
  return {
    body: content.slice(sectionBodyStart, sectionBodyEnd),
    bodyStart: sectionBodyStart,
    bodyEnd: sectionBodyEnd,
  };
};

const readOptionalSection = (content: string, sectionName: string): string => {
  try {
    return findSection(content, sectionName).body.trim();
  } catch {
    return '';
  }
};

const compactText = (content: string, limit = SUMMARY_SECTION_LIMIT): string => {
  const characters = Array.from(content);
  if (characters.length <= limit) {
    return content;
  }

  const edgeLength = Math.floor((limit - 80) / 2);
  return [
    characters.slice(0, edgeLength).join(''),
    `\n... omitted ${characters.length - edgeLength * 2} chars ...\n`,
    characters.slice(-edgeLength).join(''),
  ].join('');
};

const selectSections = (content: string, headings: string[]): string => headings
  .map((heading) => {
    const body = readOptionalSection(content, heading);
    return body ? `## ${heading}\n${compactText(body)}` : '';
  })
  .filter(Boolean)
  .join('\n\n');

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

export const replaceFileAtomically = (filePath: string, content: string): void => {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
    });
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
};

export const withManifestLock = <T>(manifestPath: string, callback: () => T): T => {
  const lockPath = `${manifestPath}.lock`;
  let lockDescriptor: number | undefined;
  try {
    lockDescriptor = openSync(lockPath, 'wx');
    writeFileSync(
      lockDescriptor,
      `${JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() })}\n`,
      'utf8',
    );
  } catch (error: unknown) {
    if (lockDescriptor !== undefined) {
      closeSync(lockDescriptor);
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`任务 manifest 正在被其他执行者更新：${lockPath}`);
    }
    throw error;
  }

  if (lockDescriptor === undefined) {
    throw new Error(`无法获取任务 manifest 锁：${lockPath}`);
  }
  try {
    return callback();
  } finally {
    try {
      closeSync(lockDescriptor);
    } finally {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    }
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
      if (transitionOptions.expectedLastUpdated &&
          transitionOptions.expectedLastUpdated !== currentModel.lastUpdated) {
        throw new Error(
          `manifest Last Updated 已变化，期望 ` +
          `${transitionOptions.expectedLastUpdated}，当前 ${currentModel.lastUpdated}`,
        );
      }
      const updatedContent = transitionManifestContent(
        originalContent,
        {
          ...transitionOptions,
          command,
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
      replaceFileAtomically(manifestPath, updatedContent);
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

const summarizeTask = (taskId: string): void => {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error('任务 ID 只能包含小写字母、数字和连字符');
  }

  const taskDirectory = path.join(tasksRoot, taskId);
  const manifestPath = path.join(taskDirectory, 'manifest.md');
  if (!existsSync(manifestPath)) {
    throw new Error(`任务 manifest 不存在：${taskId}`);
  }

  const output = [
    '# Task Resume Summary',
    `- Task: ${taskId}`,
    '',
    selectSections(
      readFileSync(manifestPath, 'utf8'),
      ['Identity', 'Repository Matrix', 'Stage Status', 'Resume'],
    ),
  ];

  const sourcePath = path.join(taskDirectory, 'source.md');
  if (existsSync(sourcePath)) {
    output.push(
      '',
      '# Source Summary',
      selectSections(
        readFileSync(sourcePath, 'utf8'),
        ['Identity', 'Selection', 'Source Gaps', 'User Additions'],
      ),
    );
  }

  const handoffPath = path.join(taskDirectory, 'handoff.md');
  if (existsSync(handoffPath)) {
    output.push(
      '',
      '# Handoff Summary',
      selectSections(
        readFileSync(handoffPath, 'utf8'),
        ['Task', 'Completed', 'Decisions', 'Repository State', 'Review / Verify', 'Blockers'],
      ),
    );
  }

  const summary = output.join('\n');
  const summaryLength = Array.from(summary).length;
  if (summaryLength > SUMMARY_OUTPUT_LIMIT) {
    throw new Error(
      `任务摘要为 ${summaryLength} 字符，超过 ${SUMMARY_OUTPUT_LIMIT} 字符上限；` +
      '请精简 Resume、Source Gaps 或 User Additions 后重试',
    );
  }

  process.stdout.write(`${summary}\n`);
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  const [command] = args;
  const taskId = readArgumentValue(args, '--task');
  const transitionOptions = {
    action: readArgumentValue(args, '--action'),
    evidence: readArgumentValue(args, '--evidence'),
    expectedLastUpdated: readArgumentValue(args, '--expected-last-updated'),
    reason: readArgumentValue(args, '--reason'),
    stage: readArgumentValue(args, '--stage'),
    to: readArgumentValue(args, '--to'),
    userApproved: args.includes('--user-approved'),
  };

  try {
    if (['start', 'advance', 'skip', 'block', 'resume', 'complete'].includes(command ?? '')) {
      updateTask(taskId, command as TaskTransitionCommand, transitionOptions);
      return 0;
    }
    if (command === 'summary') {
      summarizeTask(taskId);
      return 0;
    }

    process.stderr.write(
      'Usage: agent-workflow task ' +
      '<start|advance|skip|block|resume|complete|summary> --task <task-id> ' +
      '[--to <stage>] [--stage <stage>] [--action <text>] ' +
      '[--evidence <text>] [--reason <text>] ' +
      '[--user-approved] ' +
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
