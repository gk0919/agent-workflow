import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  validateCiVerification,
} from '../../src/core/ci-verification.js';
import { workflowRoot } from '../../src/config/workspace-paths.js';
import { errorMessage } from '../../src/types/guards.js';

interface CiFixture {
  checks: Array<{
    id: string;
    kind: string;
    status: string;
    summary: string;
  }>;
  generatedAt: string;
  overallStatus: string;
  repository: Record<string, string>;
  [key: string]: unknown;
}

const samplePath = path.join(
  workflowRoot,
  'resources',
  'examples',
  'ci-verification.sample.json',
);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const expectError = (
  result: unknown,
  pattern: RegExp,
  options: { expectedTaskId?: string } = {},
): void => {
  const errors = validateCiVerification(result, options);
  assert.match(errors.join('\n'), pattern);
};

export const main = (): number => {
  try {
    const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as CiFixture;
    assert.deepEqual(
      validateCiVerification(sample, {
        expectedTaskId: 'sample-ci-verification',
      }),
      [],
    );

    const secret = clone(sample);
    secret.checks[0]!.summary = 'token=abc123';
    expectError(secret, /凭据或敏感参数/);

    const unknownField = clone(sample);
    unknownField.repository.branch = 'main';
    expectError(unknownField, /未声明字段：branch/);

    const windowsPath = clone(sample);
    windowsPath.repository.root = 'C:\\workspace\\project';
    expectError(windowsPath, /安全的工作区相对路径/);

    const inconsistentStatus = clone(sample);
    inconsistentStatus.checks[0]!.status = 'failed';
    expectError(inconsistentStatus, /overallStatus 应为 failed/);

    const tooManyChecks = clone(sample);
    tooManyChecks.checks = Array.from({ length: 101 }, (_, index) => ({
      id: `check-${index}`,
      kind: 'test',
      status: 'passed',
      summary: '通过',
    }));
    expectError(tooManyChecks, /checks 必须包含 1-100 项/);

    const taskMismatch = clone(sample);
    expectError(
      taskMismatch,
      /taskId 必须与任务目录一致/,
      { expectedTaskId: 'another-task' },
    );

    const invalidTimestamp = clone(sample);
    invalidTimestamp.generatedAt = '2026-07-26';
    expectError(invalidTimestamp, /generatedAt 必须是合法 UTC date-time/);

    const invalidCalendarDate = clone(sample);
    invalidCalendarDate.generatedAt = '2026-02-31T00:00:00.000Z';
    expectError(
      invalidCalendarDate,
      /generatedAt 必须是合法 UTC date-time/,
    );

    process.stdout.write(
      'CI 验证协议回归通过：1 个正例、8 个安全与一致性反例。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(
      `CI 验证协议回归失败：${errorMessage(error)}\n`,
    );
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
