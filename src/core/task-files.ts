import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertRealPathWithin, loadWorkflowPaths } from '../config/workflow-config.js';

export const taskPath = (taskId: string, root = loadWorkflowPaths().tasksRoot): string => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskId)) throw new Error('Invalid task ID');
  const directory = path.join(root, taskId);
  assertRealPathWithin(directory, root, 'task');
  return directory;
};

export const readTaskFile = (directory: string, relative: string): string => {
  if (!relative || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative) ||
      relative.includes('\\') || relative.split('/').some((part) => !part || part === '..')) throw new Error('Expected task-relative file');
  const target = path.join(directory, relative);
  assertRealPathWithin(target, directory, relative);
  const stats = statSync(target);
  if (!stats.isFile() || stats.size > 4 * 1024 * 1024) throw new Error(`Not a bounded task file: ${relative}`);
  return readFileSync(target, 'utf8');
};

export const replaceFileAtomically = (filePath: string, content: string): void => {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
};

/** One lock is shared by lifecycle, progress, evidence, and checkpoint publication. */
export const withManifestLock = <T>(manifestPath: string, callback: () => T): T => {
  const lockPath = `${manifestPath}.lock`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(lockPath, 'wx');
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }), 'utf8');
  } catch (error: unknown) {
    if (descriptor !== undefined) { closeSync(descriptor); unlinkSync(lockPath); }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`任务正在被其他执行者更新：${lockPath}`);
    throw error;
  }
  try { return callback(); } finally { closeSync(descriptor); unlinkSync(lockPath); }
};
