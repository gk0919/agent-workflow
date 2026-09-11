import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadWorkflowPaths, assertRealPathWithin } from '../config/workflow-config.js';
import { readManifestModel, validateManifestTaskFlow } from './task-lifecycle.js';
import { validateHandoffState } from './task-handoff.js';
import { errorMessage } from '../types/guards.js';
import { readCheckpoint } from './task-checkpoint.js';

export interface TaskCandidate {
  taskId: string;
  entry: string;
  currentStage: string;
  status: string;
  lastActivity: string;
}

export interface TaskSelection {
  status: 'selected' | 'ambiguous' | 'none' | 'invalid';
  task: TaskCandidate | null;
  candidates: TaskCandidate[];
  errors: string[];
}

const readTask = (root: string, taskId: string, includeHandoffActivity = true): TaskCandidate => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskId)) throw new Error('Invalid task ID');
  const directory = path.join(root, taskId);
  assertRealPathWithin(directory, root, 'task');
  const read = (name: string): string => {
    const file = path.join(directory, name);
    assertRealPathWithin(file, directory, name);
    if (!statSync(file).isFile() || statSync(file).size > 4 * 1024 * 1024) {
      throw new Error(`${taskId}/${name}: invalid file size or type`);
    }
    return readFileSync(file, 'utf8');
  };
  const model = readManifestModel(read('manifest.md'));
  const errors = validateManifestTaskFlow(model);
  if (model.taskId !== taskId || !model.entryMode) errors.push('Task identity or entry is invalid');
  if (errors.length) throw new Error(errors.join('; '));
  let lastActivity = model.lastUpdated;
  if (includeHandoffActivity && model.schemaVersion === 2) {
    lastActivity = readCheckpoint(directory).savedAt;
  } else if (includeHandoffActivity && existsSync(path.join(directory, 'handoff-state.json'))) {
    const value: unknown = JSON.parse(read('handoff-state.json'));
    const stateErrors = validateHandoffState(value);
    if (stateErrors.length) throw new Error(stateErrors.join('; '));
    const state = value as { taskId: string; generatedAt: string };
    if (state.taskId !== taskId) throw new Error('Handoff task ID mismatch');
    if (Date.parse(state.generatedAt) > Date.parse(lastActivity)) lastActivity = state.generatedAt;
  }
  return {
    taskId, entry: model.entryMode, currentStage: model.currentStage,
    status: model.status, lastActivity,
  };
};

/** Selection uses recorded activity, never filesystem mtime or directory-name ordering. */
export const selectTask = (taskId = '', root = loadWorkflowPaths().tasksRoot): TaskSelection => {
  if (taskId) {
    try {
      // Explicit selection must allow inspection and repair of a damaged handoff baseline.
      const task = readTask(root, taskId, false);
      return { status: 'selected', task, candidates: [task], errors: [] };
    } catch (error: unknown) {
      return { status: 'invalid', task: null, candidates: [], errors: [errorMessage(error)] };
    }
  }
  if (!existsSync(root)) return { status: 'none', task: null, candidates: [], errors: [] };
  const candidates: TaskCandidate[] = [];
  const errors: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!existsSync(path.join(root, entry.name, 'manifest.md'))) continue;
    try {
      const task = readTask(root, entry.name);
      if (task.status !== 'complete') candidates.push(task);
    } catch (error: unknown) { errors.push(`${entry.name}: ${errorMessage(error)}`); }
  }
  candidates.sort((left, right) => Date.parse(right.lastActivity) - Date.parse(left.lastActivity) || left.taskId.localeCompare(right.taskId));
  if (errors.length) return { status: 'invalid', task: null, candidates, errors };
  if (!candidates.length) return { status: 'none', task: null, candidates, errors };
  const latest = candidates[0]!;
  const tied = candidates.filter((candidate) => Date.parse(candidate.lastActivity) === Date.parse(latest.lastActivity));
  return tied.length === 1
    ? { status: 'selected', task: latest, candidates, errors }
    : { status: 'ambiguous', task: null, candidates: tied, errors };
};

export const requireSelectedTask = (selection: TaskSelection): TaskCandidate => {
  if (selection.task) return selection.task;
  if (selection.status === 'none') throw new Error('没有可继续的本地任务；请先根据当前会话建立任务记录');
  if (selection.status === 'invalid') throw new Error(`无法自动选择任务：${selection.errors.join('; ')}`);
  throw new Error(`存在多个同样最近的任务，请确认其中一个：${selection.candidates.map((item) => `${item.taskId} (${item.currentStage})`).join(', ')}`);
};
