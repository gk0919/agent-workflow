import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const libraryDirectory = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_CONFIG_SEGMENTS = ['.agent-workflow', 'config.json'];

// Compiled modules live in dist/src/config; the immutable package resources live at package root.
export const workflowRoot = path.resolve(libraryDirectory, '..', '..', '..');

const normalizeStartDirectory = (startPath: string): string => {
  const resolvedPath = path.resolve(startPath);
  return existsSync(resolvedPath) && statSync(resolvedPath).isFile()
    ? path.dirname(resolvedPath)
    : resolvedPath;
};

/** Finds the consuming workspace without depending on the package installation location. */
export const findWorkspaceRoot = (startPath = process.cwd()): string => {
  let currentDirectory = normalizeStartDirectory(startPath);

  while (true) {
    const configPath = path.join(currentDirectory, ...PROJECT_CONFIG_SEGMENTS);
    if (existsSync(configPath)) {
      return currentDirectory;
    }
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error('找不到 .agent-workflow/config.json；请从项目目录运行或显式指定工作区');
    }
    currentDirectory = parentDirectory;
  }
};

export const workspaceRoot = findWorkspaceRoot();
export const workflowProjectRoot = path.join(workspaceRoot, '.agent-workflow');
export const workflowConfigPath = path.join(workflowProjectRoot, 'config.json');

const packageMetadata = JSON.parse(
  readFileSync(path.join(workflowRoot, 'package.json'), 'utf8'),
) as { name: string };
const dependencyRoot = path.join(
  workspaceRoot,
  'node_modules',
  ...packageMetadata.name.split('/'),
);

// Prefer the stable dependency path even when a local `file:` dependency is a symlink.
export const workflowReferenceRoot = workflowRoot === workspaceRoot || !existsSync(dependencyRoot)
  ? workflowRoot
  : dependencyRoot;
export const workflowEntryReference = path
  .relative(workspaceRoot, path.join(workflowReferenceRoot, 'docs', 'START.md'))
  .split(path.sep)
  .join('/');
