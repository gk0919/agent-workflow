import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
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

/** Checks every package-owned JavaScript module without executing it. */
export const main = (): number => {
  const files = collectModules(path.join(workflowRoot, 'dist')).sort();

  for (const filePath of files) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout || `语法检查失败：${filePath}\n`);
      return 1;
    }
  }
  process.stdout.write(`工作流语法检查通过：${files.length} 个模块。\n`);
  return 0;
};

process.exitCode = main();
