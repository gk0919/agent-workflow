/** Regression contract for how the syntax gate reports a failed check. */
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { describeSyntaxCheckFailure } from '../../src/validators/syntax-check.js';

export const main = (): number => {
  try {
    const spawnFailure = describeSyntaxCheckFailure({
      error: new Error('spawn EPERM'),
      status: null,
    }, 'dist/fixture.js');
    assert.match(spawnFailure, /语法检查无法执行/);
    assert.match(spawnFailure, /spawn EPERM/);
    assert.doesNotMatch(spawnFailure, /语法检查失败/);

    assert.equal(
      describeSyntaxCheckFailure({
        status: 1,
        stderr: 'SyntaxError: Unexpected token',
      }, 'dist/fixture.js'),
      'SyntaxError: Unexpected token',
    );

    assert.equal(
      describeSyntaxCheckFailure({ status: 1 }, 'dist/fixture.js'),
      '语法检查失败：dist/fixture.js',
    );

    process.stdout.write('语法检查报告回归通过：子进程失败与真实语法错误可区分。\n');
    return 0;
  } catch (error: unknown) {
    process.stderr.write(
      `语法检查报告回归失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
