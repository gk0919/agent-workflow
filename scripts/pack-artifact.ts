import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Compiled scripts live in dist/scripts; package assets remain rooted two levels above.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputDirectory = path.join(packageRoot, 'artifacts');

mkdirSync(outputDirectory, { recursive: true });
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  process.stderr.write('pack:artifact 必须通过 npm run 调用。\n');
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  [
    npmCliPath,
    'pack',
    '--ignore-scripts',
    '--pack-destination',
    outputDirectory,
  ],
  {
    cwd: packageRoot,
    stdio: 'inherit',
    windowsHide: true,
  },
);

if (result.error) {
  process.stderr.write(`npm pack 启动失败：${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
