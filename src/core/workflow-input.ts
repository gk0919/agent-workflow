import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { workspaceRoot } from '../config/workspace-paths.js';

interface WorkflowInputOptions {
  allowedPrefix?: string;
  label?: string;
  maxBytes: number;
}

export interface WorkflowInputFile {
  content: string;
  displayPath: string;
  resolvedPath: string;
}

const normalizeDisplayPath = (relativePath: string): string =>
  relativePath.split(path.sep).join('/');

const isNestedPath = (rootPath: string, targetPath: string): boolean => {
  const relativePath = path.relative(rootPath, targetPath);
  return Boolean(relativePath) && !path.isAbsolute(relativePath) &&
    relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`);
};

export const readWorkflowInputFile = (
  relativePath: string,
  {
    allowedPrefix = '',
    label = '工作流输入文件',
    maxBytes,
  }: WorkflowInputOptions,
): WorkflowInputFile => {
  if (typeof relativePath !== 'string' || !relativePath.trim() ||
      path.isAbsolute(relativePath)) {
    throw new Error(`${label}必须使用工作区相对路径`);
  }
  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  if (!isNestedPath(workspaceRoot, resolvedPath)) {
    throw new Error(`${label}路径越界`);
  }
  const displayPath = normalizeDisplayPath(path.relative(workspaceRoot, resolvedPath));
  if (allowedPrefix && !displayPath.startsWith(allowedPrefix)) {
    throw new Error(`${label}必须位于 ${allowedPrefix}`);
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`${label}不存在或不是文件`);
  }
  if (!isNestedPath(realpathSync(workspaceRoot), realpathSync(resolvedPath))) {
    throw new Error(`${label}路径越界`);
  }
  const fileStat = statSync(resolvedPath);
  if (!fileStat.isFile()) {
    throw new Error(`${label}不存在或不是文件`);
  }
  const size = fileStat.size;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || size > maxBytes) {
    throw new Error(`${label}超过 ${maxBytes} 字节上限`);
  }
  const content = readFileSync(resolvedPath, 'utf8');
  if (content.includes('\0') || content.includes('\uFFFD')) {
    throw new Error(`${label}必须是有效 UTF-8 文本`);
  }
  return {
    content,
    displayPath,
    resolvedPath,
  };
};
