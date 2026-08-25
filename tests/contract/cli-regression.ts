import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { workflowRoot, workspaceRoot } from '../../src/config/workspace-paths.js';
import { errorMessage } from '../../src/types/guards.js';

const cliPath = path.join(workflowRoot, 'dist', 'bin', 'agent-workflow.js');

const runCli = (args: string[], cwd = workspaceRoot) => spawnSync(process.execPath, [cliPath, ...args], {
  cwd,
  encoding: 'utf8',
  env: process.env,
  windowsHide: true,
});

/** 防止公开命令界面因内部路径或版本变化而漂移。 */
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
    assert.match(help.stdout, /\n  execution:plan\n/);
    assert.match(help.stdout, /\n  execution:run\n/);
    assert.match(help.stdout, /\n  execution:parallel:run\n/);
    assert.match(help.stdout, /\n  execution:portability:test\n/);
    assert.match(help.stdout, /\n  execution:writable:test\n/);
    assert.match(help.stdout, /quality:policy/);

    const standalonePlanHelp = runCli(['execution:plan', '--help'], tmpdir());
    assert.equal(standalonePlanHelp.status, 0, standalonePlanHelp.stderr);
    assert.match(standalonePlanHelp.stdout, /workspace-relative-json/);
    const standaloneRunHelp = runCli(['execution:run', '--help'], tmpdir());
    assert.equal(standaloneRunHelp.status, 0, standaloneRunHelp.stderr);
    assert.match(standaloneRunHelp.stdout, /execution:resume/);
    assert.match(standaloneRunHelp.stdout, /--scheduler serial\|parallel/);

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
