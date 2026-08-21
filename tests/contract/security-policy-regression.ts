import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadSecurityPolicy,
  validateSecurityPolicy,
} from '../../src/core/security-policy.js';
import type { SecurityPolicy } from '../../src/core/security-policy.js';
import { errorMessage } from '../../src/types/guards.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const expectError = (policy: SecurityPolicy, pattern: RegExp): void =>
  assert.match(validateSecurityPolicy(policy).join('\n'), pattern);

export const main = (): number => {
  try {
    const policy = loadSecurityPolicy();
    assert.deepEqual(validateSecurityPolicy(policy), []);

    const trustedUserInput = clone(policy);
    trustedUserInput.sourceTrust['user-message'] = 'trusted';
    expectError(trustedUserInput, /user-message 必须为 untrusted/);

    const enlargedRetryBudget = clone(policy);
    enlargedRetryBudget.executionBudgets.maxSameOperationRetries = 20;
    expectError(enlargedRetryBudget, /maxSameOperationRetries 必须在 1-2/);

    const weakenedExternalApproval = clone(policy);
    weakenedExternalApproval.toolClasses['external-write']!.approval = 'task-scope';
    expectError(
      weakenedExternalApproval,
      /external-write 的 risk\/approval 必须为 high\/exact-call/,
    );

    const missingExfiltrationBoundary = clone(policy);
    missingExfiltrationBoundary.untrustedContent.mustNotControl =
      missingExfiltrationBoundary.untrustedContent.mustNotControl
        .filter((item) => item !== 'data exfiltration');
    expectError(
      missingExfiltrationBoundary,
      /mustNotControl 缺少 data exfiltration/,
    );

    process.stdout.write(
      'Agent 安全策略回归通过：1 个正例、4 个防弱化反例。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(
      `Agent 安全策略回归失败：${errorMessage(error)}\n`,
    );
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
