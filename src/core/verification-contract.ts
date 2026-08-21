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
import { errorMessage, isJsonObject } from '../types/guards.js';

interface ArrayValidationOptions {
  label: string;
  maxItems: number;
  minItems?: number;
}

interface IdentifierValidationOptions {
  label: string;
  pattern: RegExp;
}

interface ReferenceValidationOptions {
  allowedIds: Set<string>;
  label: string;
  pattern: RegExp;
}

interface ChangeValidationOptions {
  acceptanceIds: Set<string>;
  idPattern: RegExp;
  label: string;
  plannedChangeIds?: Set<string> | null;
}

interface ContractTarget {
  expectedTaskId: string;
  filePath: string;
}

const MAX_CONTRACT_BYTES = 128 * 1024;
const samplePath = path.join(
  workflowRoot,
  'resources',
  'examples',
  'verification-contract.sample.json',
);
const tasksRoot = loadWorkflowPaths().tasksRoot;
const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GOAL_ID_PATTERN = /^G[1-9][0-9]*$/;
const ACCEPTANCE_ID_PATTERN = /^AC[1-9][0-9]*$/;
const OUT_OF_SCOPE_ID_PATTERN = /^OOS[1-9][0-9]*$/;
const PLANNED_CHANGE_ID_PATTERN = /^C[1-9][0-9]*$/;
const ACTUAL_CHANGE_ID_PATTERN = /^A[1-9][0-9]*$/;
const TEST_POINT_ID_PATTERN = /^VT[1-9][0-9]*$/;
const CONTRACT_STATUSES = new Set<string>([
  'planned',
  'implemented',
  'verified',
  'conditional',
]);
const METHODS = new Set<string>([
  'static',
  'mcp-playwright',
  'mcp-other',
  'cli',
  'ci',
  'manual',
  'not-verifiable',
]);
const EXECUTORS = new Set<string>(['agent', 'human', 'ci']);
const TEST_STATUSES = new Set<string>([
  'planned',
  'passed',
  'failed',
  'blocked',
  'not-applicable',
]);
const CAPABILITY_VALUES = new Set<string>(['yes', 'no', 'unknown']);

const oneLine = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  Array.from(value).length <= maxLength &&
  !/[\r\n]/.test(value);

const optionalOneLine = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' &&
  Array.from(value).length <= maxLength &&
  !/[\r\n]/.test(value);

const text = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  Array.from(value).length <= maxLength;

const isSafeRelativePath = (value: unknown): value is string => {
  if (!oneLine(value, 300) ||
      value.includes('\\') ||
      path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized !== '..' && !normalized.startsWith('../');
};

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

const validateArray = (
  value: unknown,
  {
    label,
    maxItems,
    minItems = 0,
  }: ArrayValidationOptions,
  errors: string[],
): value is unknown[] => {
  if (!Array.isArray(value) ||
      value.length < minItems ||
      value.length > maxItems) {
    errors.push(`${label} 必须包含 ${minItems}-${maxItems} 项`);
    return false;
  }
  return true;
};

const validateIdentifiers = (
  items: unknown[],
  {
    label,
    pattern,
  }: IdentifierValidationOptions,
  errors: string[],
): Set<string> => {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    const id = isJsonObject(item) && typeof item.id === 'string' ? item.id : '';
    if (!pattern.test(id)) {
      errors.push(`${label}[${index}].id 非法`);
    } else if (ids.has(id)) {
      errors.push(`${label} 包含重复 ID：${id}`);
    }
    if (id) {
      ids.add(id);
    }
  });
  return ids;
};

const validateReferences = (
  values: unknown,
  {
    allowedIds,
    label,
    pattern,
  }: ReferenceValidationOptions,
  errors: string[],
): void => {
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`${label} 必须是非空数组`);
    return;
  }
  const uniqueValues = new Set(values);
  if (uniqueValues.size !== values.length) {
    errors.push(`${label} 不能包含重复 ID`);
  }
  values.forEach((value) => {
    const reference = typeof value === 'string' ? value : '';
    if (!pattern.test(reference) || !allowedIds.has(reference)) {
      errors.push(`${label} 引用了未知 ID：${reference || '空'}`);
    }
  });
};

const validateChange = (
  change: unknown,
  {
    acceptanceIds,
    idPattern,
    label,
    plannedChangeIds = null,
  }: ChangeValidationOptions,
  errors: string[],
): void => {
  const allowedKeys = [
    'id',
    'repository',
    'path',
    'summary',
    'acceptanceIds',
  ];
  if (plannedChangeIds) {
    allowedKeys.push('plannedChangeIds');
  }
  rejectUnknownKeys(change, allowedKeys, label, errors);
  const record = isJsonObject(change) ? change : {};
  const id = typeof record.id === 'string' ? record.id : '';
  if (!idPattern.test(id)) {
    errors.push(`${label}.id 非法`);
  }
  if (!isSafeRelativePath(record.repository) ||
      Array.from(typeof record.repository === 'string' ? record.repository : '').length > 200) {
    errors.push(`${label}.repository 必须是安全的工作区相对路径`);
  }
  if (!isSafeRelativePath(record.path)) {
    errors.push(`${label}.path 必须是安全的仓库相对文件路径`);
  }
  if (!oneLine(record.summary, 500)) {
    errors.push(`${label}.summary 必须是 1-500 字符单行文本`);
  }
  validateReferences(
    record.acceptanceIds,
    {
      allowedIds: acceptanceIds,
      label: `${label}.acceptanceIds`,
      pattern: ACCEPTANCE_ID_PATTERN,
    },
    errors,
  );
  if (plannedChangeIds) {
    validateReferences(
      record.plannedChangeIds,
      {
        allowedIds: plannedChangeIds,
        label: `${label}.plannedChangeIds`,
        pattern: PLANNED_CHANGE_ID_PATTERN,
      },
      errors,
    );
  }
};

const validateTestPoint = (
  testPoint: unknown,
  index: number,
  acceptanceIds: Set<string>,
  errors: string[],
): void => {
  const label = `testPoints[${index}]`;
  rejectUnknownKeys(
    testPoint,
    [
      'id',
      'acceptanceIds',
      'method',
      'executor',
      'instructions',
      'expected',
      'status',
      'capability',
      'evidence',
      'blocker',
    ],
    label,
    errors,
  );
  const record = isJsonObject(testPoint) ? testPoint : {};
  const id = typeof record.id === 'string' ? record.id : '';
  if (!TEST_POINT_ID_PATTERN.test(id)) {
    errors.push(`${label}.id 非法`);
  }
  validateReferences(
    record.acceptanceIds,
    {
      allowedIds: acceptanceIds,
      label: `${label}.acceptanceIds`,
      pattern: ACCEPTANCE_ID_PATTERN,
    },
    errors,
  );
  if (typeof record.method !== 'string' || !METHODS.has(record.method)) {
    errors.push(`${label}.method 非法`);
  }
  if (typeof record.executor !== 'string' || !EXECUTORS.has(record.executor)) {
    errors.push(`${label}.executor 非法`);
  }
  if (!text(record.instructions, 1000)) {
    errors.push(`${label}.instructions 必须是 1-1000 字符文本`);
  }
  if (!text(record.expected, 1000)) {
    errors.push(`${label}.expected 必须是 1-1000 字符文本`);
  }
  if (typeof record.status !== 'string' || !TEST_STATUSES.has(record.status)) {
    errors.push(`${label}.status 非法`);
  }
  if (!validateArray(
    record.evidence,
    { label: `${label}.evidence`, maxItems: 20 },
    errors,
  )) {
    return;
  }
  const evidenceItems = record.evidence as unknown[];
  evidenceItems.forEach((evidence, evidenceIndex) => {
    if (!oneLine(evidence, 500)) {
      errors.push(`${label}.evidence[${evidenceIndex}] 必须是 1-500 字符单行文本`);
    }
  });
  if (!optionalOneLine(record.blocker, 500)) {
    errors.push(`${label}.blocker 必须是 0-500 字符单行文本`);
  }
  const status = typeof record.status === 'string' ? record.status : '';
  const method = typeof record.method === 'string' ? record.method : '';
  const executor = typeof record.executor === 'string' ? record.executor : '';
  if (['passed', 'failed'].includes(status) && evidenceItems.length === 0) {
    errors.push(`${label}: ${status} 必须提供 evidence`);
  }
  if (['blocked', 'not-applicable'].includes(status) &&
      !oneLine(record.blocker, 500)) {
    errors.push(`${label}: ${status} 必须说明 blocker`);
  }
  if (method === 'manual' && executor !== 'human') {
    errors.push(`${label}: manual 必须由 human 执行`);
  }
  if (method === 'ci' && executor !== 'ci') {
    errors.push(`${label}: ci 必须由 ci 执行`);
  }
  const isMcp = ['mcp-playwright', 'mcp-other'].includes(method);
  if (isMcp && executor !== 'agent') {
    errors.push(`${label}: MCP 必须由 agent 执行`);
  }
  if (isMcp) {
    const capability = isJsonObject(record.capability) ? record.capability : {};
    rejectUnknownKeys(
      capability,
      ['available', 'authorized', 'environmentReady'],
      `${label}.capability`,
      errors,
    );
    const capabilityFields = ['available', 'authorized', 'environmentReady'] as const;
    capabilityFields.forEach((field) => {
      if (typeof capability[field] !== 'string' || !CAPABILITY_VALUES.has(capability[field])) {
        errors.push(`${label}.capability.${field} 非法`);
      }
    });
    if (['passed', 'failed'].includes(status) &&
        capabilityFields
          .some((field) => capability[field] !== 'yes')) {
      errors.push(`${label}: MCP 通过或失败前能力、授权和环境必须全部为 yes`);
    }
  } else if (record.capability !== undefined) {
    errors.push(`${label}: 非 MCP 验证不得包含 capability`);
  }
  if (method === 'not-verifiable' &&
      !['blocked', 'not-applicable'].includes(status)) {
    errors.push(`${label}: not-verifiable 只能标记为 blocked 或 not-applicable`);
  }
};

export const validateVerificationContract = (
  contract: unknown,
  { expectedTaskId = '' }: { expectedTaskId?: string } = {},
): string[] => {
  const errors: string[] = [];
  const record = isJsonObject(contract) ? contract : {};
  rejectUnknownKeys(
    contract,
    [
      'schemaVersion',
      'taskId',
      'contractStatus',
      'goals',
      'acceptanceCriteria',
      'outOfScope',
      'plannedChanges',
      'actualChanges',
      'testPoints',
    ],
    'contract',
    errors,
  );
  if (record.schemaVersion !== 1) {
    errors.push('schemaVersion 必须为 1');
  }
  const taskId = typeof record.taskId === 'string' ? record.taskId : '';
  if (!TASK_ID_PATTERN.test(taskId)) {
    errors.push('taskId 非法');
  }
  if (expectedTaskId && taskId !== expectedTaskId) {
    errors.push(`taskId 必须与任务目录一致：${expectedTaskId}`);
  }
  const contractStatus = typeof record.contractStatus === 'string'
    ? record.contractStatus
    : '';
  if (!CONTRACT_STATUSES.has(contractStatus)) {
    errors.push('contractStatus 非法');
  }

  const goalsValid = validateArray(
    record.goals,
    { label: 'goals', minItems: 1, maxItems: 20 },
    errors,
  );
  const goals: unknown[] = goalsValid && Array.isArray(record.goals)
    ? record.goals
    : [];
  const goalIds = validateIdentifiers(
    goals,
    { label: 'goals', pattern: GOAL_ID_PATTERN },
    errors,
  );
  goals.forEach((goal, index) => {
    rejectUnknownKeys(goal, ['id', 'statement'], `goals[${index}]`, errors);
    const goalRecord = isJsonObject(goal) ? goal : {};
    if (!oneLine(goalRecord.statement, 500)) {
      errors.push(`goals[${index}].statement 必须是 1-500 字符单行文本`);
    }
  });

  const acceptanceValid = validateArray(
    record.acceptanceCriteria,
    { label: 'acceptanceCriteria', minItems: 1, maxItems: 50 },
    errors,
  );
  const acceptanceCriteria: unknown[] = acceptanceValid &&
    Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria
    : [];
  const acceptanceIds = validateIdentifiers(
    acceptanceCriteria,
    { label: 'acceptanceCriteria', pattern: ACCEPTANCE_ID_PATTERN },
    errors,
  );
  acceptanceCriteria.forEach((criterion, index) => {
    rejectUnknownKeys(
      criterion,
      ['id', 'goalIds', 'statement'],
      `acceptanceCriteria[${index}]`,
      errors,
    );
    const criterionRecord = isJsonObject(criterion) ? criterion : {};
    validateReferences(
      criterionRecord.goalIds,
      {
        allowedIds: goalIds,
        label: `acceptanceCriteria[${index}].goalIds`,
        pattern: GOAL_ID_PATTERN,
      },
      errors,
    );
    if (!oneLine(criterionRecord.statement, 500)) {
      errors.push(
        `acceptanceCriteria[${index}].statement 必须是 1-500 字符单行文本`,
      );
    }
  });
  goalIds.forEach((goalId) => {
    if (!acceptanceCriteria.some((criterion) => {
      const ids = isJsonObject(criterion) && Array.isArray(criterion.goalIds)
        ? criterion.goalIds
        : [];
      return ids.includes(goalId);
    })) {
      errors.push(`${goalId} 没有 Acceptance Criterion`);
    }
  });

  const outOfScopeValid = validateArray(
    record.outOfScope,
    { label: 'outOfScope', maxItems: 50 },
    errors,
  );
  const outOfScope: unknown[] = outOfScopeValid && Array.isArray(record.outOfScope)
    ? record.outOfScope
    : [];
  validateIdentifiers(
    outOfScope,
    { label: 'outOfScope', pattern: OUT_OF_SCOPE_ID_PATTERN },
    errors,
  );
  outOfScope.forEach((item, index) => {
    rejectUnknownKeys(item, ['id', 'statement'], `outOfScope[${index}]`, errors);
    const itemRecord = isJsonObject(item) ? item : {};
    if (!oneLine(itemRecord.statement, 500)) {
      errors.push(`outOfScope[${index}].statement 必须是 1-500 字符单行文本`);
    }
  });

  const plannedValid = validateArray(
    record.plannedChanges,
    { label: 'plannedChanges', minItems: 1, maxItems: 100 },
    errors,
  );
  const plannedChanges: unknown[] = plannedValid &&
    Array.isArray(record.plannedChanges)
    ? record.plannedChanges
    : [];
  const plannedChangeIds = validateIdentifiers(
    plannedChanges,
    { label: 'plannedChanges', pattern: PLANNED_CHANGE_ID_PATTERN },
    errors,
  );
  plannedChanges.forEach((change, index) =>
    validateChange(
      change,
      {
        acceptanceIds,
        idPattern: PLANNED_CHANGE_ID_PATTERN,
        label: `plannedChanges[${index}]`,
      },
      errors,
    ));

  const actualValid = validateArray(
    record.actualChanges,
    { label: 'actualChanges', maxItems: 100 },
    errors,
  );
  const actualChanges: unknown[] = actualValid && Array.isArray(record.actualChanges)
    ? record.actualChanges
    : [];
  validateIdentifiers(
    actualChanges,
    { label: 'actualChanges', pattern: ACTUAL_CHANGE_ID_PATTERN },
    errors,
  );
  actualChanges.forEach((change, index) =>
    validateChange(
      change,
      {
        acceptanceIds,
        idPattern: ACTUAL_CHANGE_ID_PATTERN,
        label: `actualChanges[${index}]`,
        plannedChangeIds,
      },
      errors,
    ));

  const testPointsValid = validateArray(
    record.testPoints,
    { label: 'testPoints', minItems: 1, maxItems: 100 },
    errors,
  );
  const testPoints: unknown[] = testPointsValid && Array.isArray(record.testPoints)
    ? record.testPoints
    : [];
  validateIdentifiers(
    testPoints,
    { label: 'testPoints', pattern: TEST_POINT_ID_PATTERN },
    errors,
  );
  testPoints.forEach((testPoint, index) =>
    validateTestPoint(testPoint, index, acceptanceIds, errors));

  acceptanceIds.forEach((acceptanceId) => {
    if (!plannedChanges.some((change) => {
      const ids = isJsonObject(change) && Array.isArray(change.acceptanceIds)
        ? change.acceptanceIds
        : [];
      return ids.includes(acceptanceId);
    })) {
      errors.push(`${acceptanceId} 没有 Planned Change`);
    }
    if (!testPoints.some((testPoint) => {
      const ids = isJsonObject(testPoint) && Array.isArray(testPoint.acceptanceIds)
        ? testPoint.acceptanceIds
        : [];
      return ids.includes(acceptanceId);
    })) {
      errors.push(`${acceptanceId} 没有 Verification Test Point`);
    }
  });

  if (['implemented', 'verified'].includes(contractStatus) &&
      actualChanges.length === 0) {
    errors.push(`${contractStatus} 契约必须包含 Actual Change`);
  }
  if (contractStatus === 'planned' && actualChanges.length > 0) {
    errors.push('planned 契约不得提前包含 Actual Change');
  }
  if (contractStatus === 'verified') {
    const incomplete = testPoints
      .filter((testPoint) => {
        const status = isJsonObject(testPoint) && typeof testPoint.status === 'string'
          ? testPoint.status
          : '';
        return !['passed', 'not-applicable'].includes(status);
      })
      .map((testPoint) => isJsonObject(testPoint) ? testPoint.id : undefined);
    if (incomplete.length > 0) {
      errors.push(`verified 契约仍有未完成 Test Point：${incomplete.join(', ')}`);
    }
    acceptanceIds.forEach((acceptanceId) => {
      if (!testPoints.some((testPoint) => {
        if (!isJsonObject(testPoint)) {
          return false;
        }
        const ids = Array.isArray(testPoint.acceptanceIds)
          ? testPoint.acceptanceIds
          : [];
        return ids.includes(acceptanceId) && testPoint.status === 'passed';
      })) {
        errors.push(`verified 契约的 ${acceptanceId} 没有 passed Test Point`);
      }
    });
  }
  if (containsSensitiveData(JSON.stringify(contract) ?? '')) {
    errors.push('验证契约疑似包含凭据或敏感参数');
  }
  return errors;
};

export const validateVerificationContractFile = (
  filePath: string,
  { expectedTaskId = '' }: { expectedTaskId?: string } = {},
): string[] => {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return [`文件不存在：${filePath}`];
  }
  if (statSync(filePath).size > MAX_CONTRACT_BYTES) {
    return [`验证契约超过 ${MAX_CONTRACT_BYTES} bytes`];
  }
  try {
    const contract = JSON.parse(readFileSync(filePath, 'utf8'));
    return validateVerificationContract(contract, { expectedTaskId });
  } catch (error) {
    return [`JSON 解析失败：${errorMessage(error)}`];
  }
};

const resolveWorkspacePath = (relativePath: string): string => {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error('--file 必须是工作区相对路径');
  }
  return path.resolve(workspaceRoot, relativePath);
};

const taskContractFiles = (): ContractTarget[] => {
  if (!existsSync(tasksRoot)) {
    return [];
  }
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      const filePath = path.join(tasksRoot, name, 'verification.json');
      return existsSync(filePath) ? [{ expectedTaskId: name, filePath }] : [];
    });
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  try {
    let targets: ContractTarget[];
    if (args.length === 0 || (args.length === 1 && args[0] === '--all')) {
      targets = [
        {
          expectedTaskId: 'sample-verification-contract',
          filePath: samplePath,
        },
        ...taskContractFiles(),
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
        'Usage: agent-workflow verify:contract ' +
        '[--all|--file <relative-path>]',
      );
    }
    const failures = targets.flatMap(({ expectedTaskId, filePath }) =>
      validateVerificationContractFile(filePath, { expectedTaskId })
        .map((message) =>
          `${path.relative(workspaceRoot, filePath)}: ${message}`));
    failures.forEach((failure) => process.stderr.write(`ERROR: ${failure}\n`));
    if (failures.length > 0) {
      return 1;
    }
    process.stdout.write(`目标与验证契约检查通过：${targets.length} 个文件。\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`目标与验证契约检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
