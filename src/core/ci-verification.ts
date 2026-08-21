import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadWorkflowPaths } from '../config/workflow-config.js';
import { workflowRoot } from '../config/workspace-paths.js';
import { containsSensitiveData } from './knowledge-state.js';
import { workspaceRoot } from './context-budget.js';
import type { UnknownRecord } from '../types/contracts.js';
import { errorMessage, isJsonObject } from '../types/guards.js';

interface ResultTarget {
  expectedTaskId: string;
  filePath: string;
}

const MAX_RESULT_BYTES = 64 * 1024;
const samplePath = path.join(
  workflowRoot,
  'resources',
  'examples',
  'ci-verification.sample.json',
);
const tasksRoot = loadWorkflowPaths().tasksRoot;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_REF_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const SHA_PATTERN = /^[a-f0-9]{7,64}$/;
const PROVIDERS = new Set(['github-actions', 'gitlab-ci', 'jenkins', 'other']);
const CHECK_KINDS = new Set(['build', 'test', 'smoke', 'lint', 'security', 'other']);
const CHECK_STATUSES = new Set(['passed', 'failed', 'skipped']);
const OVERALL_STATUSES = new Set(['passed', 'failed', 'partial']);
const UTC_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isSafeRelativePath = (value: unknown): value is string => {
  if (typeof value !== 'string' ||
      !value ||
      value.includes('\\') ||
      path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value)) {
    return false;
  }
  const normalized = path.normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
};

const oneLine = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  Array.from(value).length <= maxLength &&
  !/[\r\n]/.test(value);

const rejectUnknownKeys = (
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
  errors: string[],
): void => {
  if (!isJsonObject(value)) {
    return;
  }
  Object.keys(value)
    .filter((key) => !allowedKeys.includes(key))
    .forEach((key) => errors.push(`${label} 包含未声明字段：${key}`));
};

export const validateCiVerification = (
  result: unknown,
  { expectedTaskId = '' }: { expectedTaskId?: string } = {},
): string[] => {
  const errors: string[] = [];
  const record = isJsonObject(result) ? result : {};
  rejectUnknownKeys(
    result,
    [
      'schemaVersion',
      'taskId',
      'repository',
      'environment',
      'checks',
      'overallStatus',
      'generatedAt',
    ],
    'result',
    errors,
  );
  if (record.schemaVersion !== 1) {
    errors.push('schemaVersion 必须为 1');
  }
  const taskId = typeof record.taskId === 'string' ? record.taskId : '';
  if (!ID_PATTERN.test(taskId)) {
    errors.push('taskId 非法');
  }
  if (expectedTaskId && taskId !== expectedTaskId) {
    errors.push(`taskId 必须与任务目录一致：${expectedTaskId}`);
  }
  const repository = isJsonObject(record.repository) ? record.repository : {};
  rejectUnknownKeys(
    repository,
    ['name', 'root', 'commitSha'],
    'repository',
    errors,
  );
  if (!oneLine(repository.name, 80)) {
    errors.push('repository.name 必须是 1-80 字符单行文本');
  }
  if (!isSafeRelativePath(repository.root) ||
      Array.from(repository.root || '').length > 200) {
    errors.push('repository.root 必须是安全的工作区相对路径');
  }
  if (!SHA_PATTERN.test(typeof repository.commitSha === 'string'
    ? repository.commitSha
    : '')) {
    errors.push('repository.commitSha 必须是 7-64 位小写十六进制');
  }
  const environment = isJsonObject(record.environment) ? record.environment : {};
  rejectUnknownKeys(
    environment,
    ['provider', 'runRef', 'isolated'],
    'environment',
    errors,
  );
  if (typeof environment.provider !== 'string' ||
      !PROVIDERS.has(environment.provider)) {
    errors.push('environment.provider 非法');
  }
  if (!RUN_REF_PATTERN.test(typeof environment.runRef === 'string'
    ? environment.runRef
    : '')) {
    errors.push('environment.runRef 非法');
  }
  if (environment.isolated !== true) {
    errors.push('environment.isolated 必须为 true');
  }
  const checks = Array.isArray(record.checks) ? record.checks : [];
  if (checks.length === 0 || checks.length > 100) {
    errors.push('checks 必须包含 1-100 项');
  } else {
    const ids = new Set<string>();
    checks.forEach((check, index) => {
      const checkRecord: UnknownRecord = isJsonObject(check) ? check : {};
      rejectUnknownKeys(
        check,
        ['id', 'kind', 'status', 'summary'],
        `checks[${index}]`,
        errors,
      );
      const checkId = typeof checkRecord.id === 'string' ? checkRecord.id : '';
      if (!ID_PATTERN.test(checkId)) {
        errors.push(`checks[${index}].id 非法`);
      } else if (ids.has(checkId)) {
        errors.push(`checks 包含重复 ID：${checkId}`);
      }
      ids.add(checkId);
      if (typeof checkRecord.kind !== 'string' ||
          !CHECK_KINDS.has(checkRecord.kind)) {
        errors.push(`checks[${index}].kind 非法`);
      }
      if (typeof checkRecord.status !== 'string' ||
          !CHECK_STATUSES.has(checkRecord.status)) {
        errors.push(`checks[${index}].status 非法`);
      }
      if (!oneLine(checkRecord.summary, 500)) {
        errors.push(`checks[${index}].summary 必须是 1-500 字符单行文本`);
      }
    });
  }
  const overallStatus = typeof record.overallStatus === 'string'
    ? record.overallStatus
    : '';
  if (!OVERALL_STATUSES.has(overallStatus)) {
    errors.push('overallStatus 非法');
  }
  const generatedAt = typeof record.generatedAt === 'string' ? record.generatedAt : '';
  const generatedAtMillis = Date.parse(generatedAt);
  if (!UTC_DATE_TIME_PATTERN.test(generatedAt) ||
      Number.isNaN(generatedAtMillis) ||
      new Date(generatedAtMillis).toISOString() !== generatedAt) {
    errors.push('generatedAt 必须是合法 UTC date-time');
  }
  if (checks.length > 0) {
    const hasFailed = checks.some((check) =>
      isJsonObject(check) && check.status === 'failed');
    const hasSkipped = checks.some((check) =>
      isJsonObject(check) && check.status === 'skipped');
    const expectedOverall = hasFailed ? 'failed' : hasSkipped ? 'partial' : 'passed';
    if (overallStatus !== expectedOverall) {
      errors.push(`overallStatus 应为 ${expectedOverall}`);
    }
  }
  if (containsSensitiveData(JSON.stringify(result) ?? '')) {
    errors.push('CI 结果疑似包含凭据或敏感参数');
  }
  return errors;
};

export const validateCiVerificationFile = (
  filePath: string,
  { expectedTaskId = '' }: { expectedTaskId?: string } = {},
): string[] => {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return [`文件不存在：${filePath}`];
  }
  if (statSync(filePath).size > MAX_RESULT_BYTES) {
    return [`CI 结果超过 ${MAX_RESULT_BYTES} bytes`];
  }
  try {
    const result = JSON.parse(readFileSync(filePath, 'utf8'));
    return validateCiVerification(result, { expectedTaskId });
  } catch (error: unknown) {
    return [`JSON 解析失败：${errorMessage(error)}`];
  }
};

const resolveWorkspacePath = (relativePath: string): string => {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error('--file 必须是工作区相对路径');
  }
  return path.resolve(workspaceRoot, relativePath);
};

const taskResultFiles = (): ResultTarget[] => {
  if (!existsSync(tasksRoot)) {
    return [];
  }
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      const filePath = path.join(tasksRoot, name, 'ci-verification.json');
      return existsSync(filePath) ? [{ expectedTaskId: name, filePath }] : [];
    });
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  try {
    let targets: ResultTarget[];
    if (args.length === 0 || (args.length === 1 && args[0] === '--all')) {
      targets = [
        { expectedTaskId: 'sample-ci-verification', filePath: samplePath },
        ...taskResultFiles(),
      ];
    } else if (args.length === 2 && args[0] === '--file') {
      const requestedPath = args[1];
      if (!requestedPath) {
        throw new Error('--file 缺少工作区相对路径');
      }
      targets = [{
        expectedTaskId: '',
        filePath: resolveWorkspacePath(requestedPath),
      }];
    } else {
      throw new Error(
        'Usage: agent-workflow verify:ci [--all|--file <relative-path>]',
      );
    }
    const failures = targets.flatMap(({ expectedTaskId, filePath }) =>
      validateCiVerificationFile(filePath, { expectedTaskId })
        .map((message) => `${path.relative(workspaceRoot, filePath)}: ${message}`));
    failures.forEach((failure) => process.stderr.write(`ERROR: ${failure}\n`));
    if (failures.length > 0) {
      return 1;
    }
    process.stdout.write(`CI 验证结果检查通过：${targets.length} 个文件。\n`);
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`CI 验证结果检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
