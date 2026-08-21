import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { workflowRoot, workspaceRoot } from '../../src/config/workspace-paths.js';
import { errorMessage } from '../../src/types/guards.js';

const cliPath = path.join(workflowRoot, 'dist', 'bin', 'agent-workflow.js');

const runCli = (args: string[]) => spawnSync(process.execPath, [cliPath, ...args], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  env: process.env,
  windowsHide: true,
});

/** Protects the public command surface from internal path and version drift. */
export const main = (): number => {
  try {
    const packageMetadata = JSON.parse(
      readFileSync(path.join(workflowRoot, 'package.json'), 'utf8'),
    );
    const version = runCli(['--version']);
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), packageMetadata.version);

    const help = runCli(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: agent-workflow <command>/);
    assert.match(help.stdout, /\n  init\n/);
    assert.match(help.stdout, /quality:policy/);

    const unknown = runCli(['unknown-command']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /未知命令/);

    process.stdout.write('CLI 契约回归通过：版本、帮助和未知命令行为稳定。\n');
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`CLI 契约回归失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
