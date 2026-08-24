import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HOST_PACKAGE_SCRIPTS } from '../../src/cli/init.js';
import { workflowRoot } from '../../src/config/workspace-paths.js';
import { errorMessage } from '../../src/types/guards.js';

const cliPath = path.join(workflowRoot, 'dist', 'bin', 'agent-workflow.js');
const exampleRoot = path.join(workflowRoot, 'examples', 'generic-host');
const generatedFiles = [
  '.agent-workflow/config.json',
  '.agent-workflow/profile/knowledge/README.md',
  '.agent-workflow/profile/policy.md',
  '.agent-workflow/profile/profile.json',
  '.agent-workflow/runtime/README.md',
  '.agents/skills/.gitkeep',
  '.gitignore',
  'AGENTS.md',
  'package.json',
];

const normalizeLineEndings = (content: string): string =>
  content.replace(/\r\n?/g, '\n');

const exampleFilePath = (relativePath: string): string => path.join(
  exampleRoot,
  relativePath === '.gitignore' ? 'gitignore.template' : relativePath,
);

const runCli = (hostRoot: string, args: string[]) => spawnSync(
  process.execPath,
  [cliPath, ...args],
  {
    cwd: hostRoot,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  },
);

const markdownFiles = (directory: string): string[] => readdirSync(
  directory,
  { withFileTypes: true },
).flatMap((entry) => {
  const targetPath = path.join(directory, entry.name);
  if (entry.isDirectory()) {
    return markdownFiles(targetPath);
  }
  return entry.isFile() && entry.name.endsWith('.md') ? [targetPath] : [];
});

/** Verifies safe initialization, idempotence and the committed generic host. */
export const main = (): number => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-init-'));
  try {
    const hostRoot = path.join(temporaryRoot, 'generic-host');
    mkdirSync(hostRoot, { recursive: true });
    mkdirSync(
      path.join(hostRoot, 'node_modules', '@gk0919', 'agent-workflow'),
      { recursive: true },
    );
    writeFileSync(path.join(hostRoot, 'AGENTS.md'), '# Generic Host Constraints\n', 'utf8');
    writeFileSync(path.join(hostRoot, '.gitignore'), 'node_modules/\ncoverage/\n', 'utf8');
    writeFileSync(path.join(hostRoot, 'package.json'), `${JSON.stringify({
      name: 'generic-host',
      version: '1.0.0',
      private: true,
      scripts: {},
      devDependencies: {
        '@gk0919/agent-workflow': 'file:../..',
      },
    }, null, 2)}\n`, 'utf8');

    const init = runCli(hostRoot, ['init']);
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const firstPass = Object.fromEntries(generatedFiles.map((relativePath) => [
      relativePath,
      readFileSync(path.join(hostRoot, relativePath), 'utf8'),
    ]));
    const secondInit = runCli(hostRoot, ['init']);
    assert.equal(secondInit.status, 0, secondInit.stderr || secondInit.stdout);
    generatedFiles.forEach((relativePath) => {
      assert.equal(
        readFileSync(path.join(hostRoot, relativePath), 'utf8'),
        firstPass[relativePath],
        `${relativePath} changed during idempotent init`,
      );
    });

    const initCheck = runCli(hostRoot, ['init', '--check']);
    assert.equal(initCheck.status, 0, initCheck.stderr || initCheck.stdout);
    const hostPackage = JSON.parse(readFileSync(path.join(hostRoot, 'package.json'), 'utf8'));
    Object.entries(HOST_PACKAGE_SCRIPTS).forEach(([name, command]) => {
      assert.equal(hostPackage.scripts[name], command);
    });
    const profile = JSON.parse(readFileSync(
      path.join(hostRoot, '.agent-workflow', 'profile', 'profile.json'),
      'utf8',
    ));
    assert.equal(profile.extends, 'workflow:resources/profiles/default/profile.json');

    for (const args of [
      ['setup', '--agent', 'all'],
      ['setup', '--agent', 'all', '--check'],
      ['profile', '--check'],
      ['context'],
      ['route', '--route', 'analysis', '--stage', 'capture', '--entry', 'direct', '--materialize'],
    ]) {
      const result = runCli(hostRoot, args);
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr || result.stdout}`);
    }

    generatedFiles.forEach((relativePath) => {
      const examplePath = exampleFilePath(relativePath);
      assert.ok(existsSync(examplePath), `example missing ${relativePath}`);
      assert.equal(
        normalizeLineEndings(readFileSync(examplePath, 'utf8')),
        normalizeLineEndings(readFileSync(path.join(hostRoot, relativePath), 'utf8')),
        `example drift: ${relativePath}`,
      );
    });
    assert.ok(existsSync(path.join(exampleRoot, '.github', 'workflows', 'agent-workflow.yml')));
    assert.ok(existsSync(path.join(exampleRoot, 'README.md')));

    const rootPackage = JSON.parse(readFileSync(path.join(workflowRoot, 'package.json'), 'utf8'));
    const availableScripts = new Set([
      ...Object.keys(rootPackage.scripts),
      ...Object.keys(HOST_PACKAGE_SCRIPTS),
    ]);
    const instructionFiles = [
      path.join(workflowRoot, 'README.md'),
      ...markdownFiles(path.join(workflowRoot, 'docs')),
      ...markdownFiles(path.join(workflowRoot, 'resources')),
    ];
    instructionFiles.forEach((filePath) => {
      const content = readFileSync(filePath, 'utf8');
      for (const match of content.matchAll(/npm run ([a-z0-9:-]+)/g)) {
        assert.ok(
          availableScripts.has(match[1] ?? ''),
          `${path.relative(workflowRoot, filePath)} references missing script ${match[1]}`,
        );
      }
    });

    const dryRunRoot = path.join(temporaryRoot, 'dry-run-host');
    mkdirSync(dryRunRoot, { recursive: true });
    const dryRunPackage = `${JSON.stringify({
      name: 'dry-run-host',
      version: '1.0.0',
      private: true,
    }, null, 2)}\n`;
    writeFileSync(path.join(dryRunRoot, 'package.json'), dryRunPackage, 'utf8');
    const dryRun = runCli(dryRunRoot, ['init', '--dry-run']);
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.equal(readFileSync(path.join(dryRunRoot, 'package.json'), 'utf8'), dryRunPackage);
    assert.equal(existsSync(path.join(dryRunRoot, '.agent-workflow')), false);

    const conflictRoot = path.join(temporaryRoot, 'conflict-host');
    mkdirSync(conflictRoot, { recursive: true });
    const conflictPackage = `${JSON.stringify({
      name: 'conflict-host',
      version: '1.0.0',
      private: true,
      scripts: { 'workflow:route': 'custom-route-command' },
    }, null, 2)}\n`;
    writeFileSync(path.join(conflictRoot, 'package.json'), conflictPackage, 'utf8');
    const conflict = runCli(conflictRoot, ['init']);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /conflict/);
    assert.equal(readFileSync(path.join(conflictRoot, 'package.json'), 'utf8'), conflictPackage);
    assert.equal(existsSync(path.join(conflictRoot, '.agent-workflow')), false);

    process.stdout.write(
      'Init 契约回归通过：安全生成、幂等检查、Profile 继承和 generic host 冒烟正常。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`Init 契约回归失败：${errorMessage(error)}\n`);
    return 1;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
