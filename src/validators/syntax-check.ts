import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { workflowRoot } from '../config/workspace-paths.js';

const collectModules = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectModules(entryPath);
    }
    return entry.isFile() && path.extname(entry.name) === '.js' ? [entryPath] : [];
  });

/** Distinguishes a subprocess that never ran from a module that really failed to parse. */
export const describeSyntaxCheckFailure = (
  result: { error?: Error; status: number | null; stderr?: string | null; stdout?: string | null },
  filePath: string,
): string => {
  if (result.error || result.status === null) {
    return `语法检查无法执行：${filePath}；子进程未正常结束：` +
      `${result.error?.message ?? 'unknown error'}`;
  }
  return result.stderr || result.stdout || `语法检查失败：${filePath}`;
};

/** Checks every package-owned JavaScript module without executing it. */
export const main = (): number => {
  const files = collectModules(path.join(workflowRoot, 'dist')).sort();

  for (const filePath of files) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      process.stderr.write(`${describeSyntaxCheckFailure(result, filePath)}\n`);
      return 1;
    }
  }
  process.stdout.write(`工作流语法检查通过：${files.length} 个模块。\n`);
  return 0;
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
