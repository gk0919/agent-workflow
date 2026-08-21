import { createHash } from 'node:crypto';
import path from 'node:path';
import { workflowRelativePath } from '../config/workflow-config.js';
import { containsSensitiveData } from './knowledge-state.js';
import { readWorkflowInputFile } from './workflow-input.js';
import type { MicroBriefSummary, UnknownRecord } from '../types/contracts.js';
import { errorMessage, isJsonObject } from '../types/guards.js';

interface GoalItem { id: string; text: string }
interface AcceptanceItem { goalId: string; id: string; text: string }
interface OutOfScopeItem { id: string; text: string }
interface ChangeItem {
  acceptanceCriteria: string[];
  actualChange: string;
  file: string;
  id: string;
  plannedChange: string;
  repository: string;
}
interface VerificationItem {
  acceptanceCriteria: string[];
  evidenceOrGap: string;
  executor: string;
  expected: string;
  id: string;
  method: string;
  preconditions: string;
  status: string;
}
interface MicroBrief {
  changeInventory: ChangeItem[];
  goalAlignment: {
    acceptanceCriteria: AcceptanceItem[];
    goals: GoalItem[];
    outOfScope: OutOfScopeItem[];
  };
  verificationMatrix: VerificationItem[];
  version: number;
}
type BriefItemType = keyof BriefItemMap;
interface BriefItemMap {
  acceptanceCriteria: AcceptanceItem;
  changeInventory: ChangeItem;
  goals: GoalItem;
  outOfScope: OutOfScopeItem;
  verificationMatrix: VerificationItem;
}
interface BriefValidationOptions {
  patchFiles?: string[];
  repository?: string;
}
interface BriefGuardOptions extends BriefValidationOptions {
  content: string;
  stage: string;
}
interface BriefFileOptions extends BriefValidationOptions {
  briefFile: string;
  stage: string;
}

export const MICRO_BRIEF_STAGES = new Set([
  'implement',
  'review-defect',
  'review-requirement',
  'verify-defect',
  'verify-requirement',
  'git-inspect',
]);
const MAX_BRIEF_BYTES = 64 * 1024;
const ID_PATTERNS: Record<BriefItemType, RegExp> = {
  acceptanceCriteria: /^AC[1-9]\d*$/,
  changeInventory: /^C[1-9]\d*$/,
  goals: /^G[1-9]\d*$/,
  outOfScope: /^OOS[1-9]\d*$/,
  verificationMatrix: /^VT[1-9]\d*$/,
};
const ITEM_KEYS: Record<BriefItemType, readonly string[]> = {
  acceptanceCriteria: ['goalId', 'id', 'text'],
  changeInventory: [
    'acceptanceCriteria',
    'actualChange',
    'file',
    'id',
    'plannedChange',
    'repository',
  ],
  goals: ['id', 'text'],
  outOfScope: ['id', 'text'],
  verificationMatrix: [
    'acceptanceCriteria',
    'evidenceOrGap',
    'executor',
    'expected',
    'id',
    'method',
    'preconditions',
    'status',
  ],
};
const METHOD_EXECUTOR = new Map<string, string>([
  ['ci', 'ci'],
  ['manual', 'human'],
  ['mcp', 'mcp'],
  ['playwright', 'playwright'],
  ['static', 'agent'],
]);
const VERIFICATION_STATUSES = new Set([
  'blocked',
  'failed',
  'not-applicable',
  'passed',
  'planned',
]);

const hashText = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

const isObject = (value: unknown): value is UnknownRecord => isJsonObject(value);

const exactKeys = (
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
  errors: string[],
): value is UnknownRecord => {
  if (!isObject(value)) {
    errors.push(`${label} 必须是对象`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = allowedKeys.slice().sort();
  if (actual.join('|') !== expected.join('|')) {
    errors.push(`${label} 字段必须为 ${expected.join(', ')}`);
    return false;
  }
  return true;
};

const oneLine = (
  value: unknown,
  label: string,
  errors: string[],
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const length = Array.from(normalized).length;
  if ((!allowEmpty && length === 0) || length > 500 ||
      typeof value !== 'string' || /[\r\n]/.test(value)) {
    errors.push(`${label} 必须是 ${allowEmpty ? '0' : '1'}-500 字符单行文本`);
    return '';
  }
  return normalized;
};

const validateRelativePath = (
  value: unknown,
  label: string,
  errors: string[],
  { allowDot = false }: { allowDot?: boolean } = {},
): string => {
  const normalized = oneLine(value, label, errors);
  if (!normalized) {
    return '';
  }
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized) ||
      normalized.includes('\\')) {
    errors.push(`${label} 必须使用正斜杠相对路径`);
    return '';
  }
  if (allowDot && normalized === '.') {
    return normalized;
  }
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    errors.push(`${label} 包含非法路径段`);
    return '';
  }
  return normalized.replace(/\/+$/, '');
};

const validateItems = <T extends BriefItemType>(
  items: unknown,
  type: T,
  errors: string[],
  { min = 1, max = 10 }: { max?: number; min?: number } = {},
): Array<BriefItemMap[T]> => {
  if (!Array.isArray(items) || items.length < min || items.length > max) {
    errors.push(`${type} 必须包含 ${min}-${max} 项`);
    return [];
  }
  const seen = new Set<string>();
  const validItems: Array<BriefItemMap[T]> = [];
  items.forEach((item, index) => {
    const label = `${type}[${index}]`;
    if (!exactKeys(item, ITEM_KEYS[type], label, errors)) {
      return;
    }
    const typedItem = item as unknown as BriefItemMap[T];
    validItems.push(typedItem);
    if (!ID_PATTERNS[type].test(typedItem.id || '') || seen.has(typedItem.id)) {
      errors.push(`${label}.id 非法或重复`);
    }
    seen.add(typedItem.id);
    if ('text' in typedItem) {
      oneLine(typedItem.text, `${label}.text`, errors);
    }
  });
  return validItems;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const planProjection = (brief: MicroBrief) => ({
  changeInventory: brief.changeInventory.map((item) => ({
    acceptanceCriteria: item.acceptanceCriteria,
    file: item.file,
    id: item.id,
    plannedChange: item.plannedChange,
    repository: item.repository,
  })),
  goalAlignment: brief.goalAlignment,
  verificationMatrix: brief.verificationMatrix.map((item) => ({
    acceptanceCriteria: item.acceptanceCriteria,
    executor: item.executor,
    expected: item.expected,
    id: item.id,
    method: item.method,
    preconditions: item.preconditions,
  })),
  version: brief.version,
});

export const validateMicroBrief = (
  brief: unknown,
  stage: string,
  {
    patchFiles = [],
    repository = '',
  }: BriefValidationOptions = {},
): string[] => {
  const errors: string[] = [];
  if (!MICRO_BRIEF_STAGES.has(stage)) {
    return [`Micro Brief 不接受阶段 ${stage}`];
  }
  if (!exactKeys(
    brief,
    ['changeInventory', 'goalAlignment', 'verificationMatrix', 'version'],
    'Micro Brief',
    errors,
  )) {
    return errors;
  }
  const briefRecord = brief;
  if (briefRecord.version !== 1) {
    errors.push('Micro Brief version 必须为 1');
  }
  if (!exactKeys(
    briefRecord.goalAlignment,
    ['acceptanceCriteria', 'goals', 'outOfScope'],
    'goalAlignment',
    errors,
  )) {
    return errors;
  }
  const typedBrief = briefRecord as unknown as MicroBrief;

  const goals = validateItems(
    typedBrief.goalAlignment.goals,
    'goals',
    errors,
    { max: 1 },
  );
  const acceptance = validateItems(
    typedBrief.goalAlignment.acceptanceCriteria,
    'acceptanceCriteria',
    errors,
    { max: 3 },
  );
  validateItems(
    typedBrief.goalAlignment.outOfScope,
    'outOfScope',
    errors,
    { max: 5 },
  );
  const changes = validateItems(
    typedBrief.changeInventory,
    'changeInventory',
    errors,
    { max: 2 },
  );
  const verification = validateItems(
    typedBrief.verificationMatrix,
    'verificationMatrix',
    errors,
    { max: 10 },
  );

  const goalIds = new Set(goals.map(({ id }) => id));
  const acceptanceIds = new Set(acceptance.map(({ id }) => id));
  const referencedByChange = new Set();
  const referencedByVerification = new Set();

  acceptance.forEach((item, index) => {
    if (!goalIds.has(item.goalId)) {
      errors.push(`acceptanceCriteria[${index}].goalId 未引用已定义 Goal`);
    }
  });
  const requiresActualChange = stage !== 'implement';
  changes.forEach((item, index) => {
    const label = `changeInventory[${index}]`;
    validateRelativePath(item.repository, `${label}.repository`, errors, {
      allowDot: true,
    });
    validateRelativePath(item.file, `${label}.file`, errors);
    oneLine(item.plannedChange, `${label}.plannedChange`, errors);
    oneLine(item.actualChange, `${label}.actualChange`, errors, {
      allowEmpty: !requiresActualChange,
    });
    if (!requiresActualChange && typeof item.actualChange === 'string' &&
        item.actualChange.trim()) {
      errors.push(`${label}.actualChange 在 Implement 阶段必须为空`);
    }
    if (!Array.isArray(item.acceptanceCriteria) ||
        item.acceptanceCriteria.length === 0) {
      errors.push(`${label}.acceptanceCriteria 必须至少引用一个 AC`);
    } else {
      item.acceptanceCriteria.forEach((acceptanceId) => {
        if (!acceptanceIds.has(acceptanceId)) {
          errors.push(`${label} 引用了未知 AC ${acceptanceId}`);
        }
        referencedByChange.add(acceptanceId);
      });
    }
  });

  const requiresFinalEvidence = stage === 'git-inspect';
  verification.forEach((item, index) => {
    const label = `verificationMatrix[${index}]`;
    oneLine(item.expected, `${label}.expected`, errors);
    oneLine(item.preconditions, `${label}.preconditions`, errors);
    oneLine(item.evidenceOrGap, `${label}.evidenceOrGap`, errors, {
      allowEmpty: !requiresFinalEvidence,
    });
    if (stage === 'implement' && typeof item.evidenceOrGap === 'string' &&
        item.evidenceOrGap.trim()) {
      errors.push(`${label}.evidenceOrGap 在 Implement 阶段必须为空`);
    }
    if (!Array.isArray(item.acceptanceCriteria) ||
        item.acceptanceCriteria.length === 0) {
      errors.push(`${label}.acceptanceCriteria 必须至少引用一个 AC`);
    } else {
      item.acceptanceCriteria.forEach((acceptanceId) => {
        if (!acceptanceIds.has(acceptanceId)) {
          errors.push(`${label} 引用了未知 AC ${acceptanceId}`);
        }
        referencedByVerification.add(acceptanceId);
      });
    }
    if (!METHOD_EXECUTOR.has(item.method) ||
        METHOD_EXECUTOR.get(item.method) !== item.executor) {
      errors.push(`${label}.method 与 executor 组合非法`);
    }
    if (!VERIFICATION_STATUSES.has(item.status)) {
      errors.push(`${label}.status 非法`);
    }
    if (stage === 'implement' && item.status !== 'planned') {
      errors.push(`${label}.status 在 Implement 阶段必须为 planned`);
    }
    if (requiresFinalEvidence && item.status === 'planned') {
      errors.push(`${label}.status 在 Git Inspect 前不能仍为 planned`);
    }
  });

  acceptanceIds.forEach((acceptanceId) => {
    if (!referencedByChange.has(acceptanceId)) {
      errors.push(`${acceptanceId} 未映射 Change Inventory`);
    }
    if (!referencedByVerification.has(acceptanceId)) {
      errors.push(`${acceptanceId} 未映射 Verification Matrix`);
    }
  });

  if (patchFiles.length > 0) {
    const briefFiles = changes.map(({ file }) => file).sort();
    const actualPatchFiles = patchFiles.slice().sort();
    if (briefFiles.join('|') !== actualPatchFiles.join('|')) {
      errors.push('Change Inventory 文件与任务 patch 不一致');
    }
  }
  if (repository) {
    changes.forEach((item) => {
      if (item.repository !== repository) {
        errors.push('Change Inventory Repository 与 --repository 不一致');
      }
    });
  }
  return errors;
};

export const guardMicroBriefContent = ({
  content,
  patchFiles = [],
  repository = '',
  stage,
}: BriefGuardOptions): MicroBriefSummary & { briefHash: string } => {
  if (typeof content !== 'string') {
    throw new Error('Micro Brief Gate: 内容必须是 UTF-8 JSON 文本');
  }
  if (containsSensitiveData(content)) {
    throw new Error('Micro Brief Gate: 文件包含疑似凭据或敏感参数');
  }
  let brief: unknown;
  try {
    brief = JSON.parse(content);
  } catch (error: unknown) {
    throw new Error(`Micro Brief Gate: JSON 无法解析（${errorMessage(error)}）`);
  }
  const errors = validateMicroBrief(brief, stage, {
    patchFiles,
    repository,
  });
  if (errors.length > 0) {
    throw new Error(`Micro Brief Gate: ${errors[0]}`);
  }
  const typedBrief = brief as MicroBrief;
  return {
    acceptanceCount: typedBrief.goalAlignment.acceptanceCriteria.length,
    briefHash: hashText(stableStringify(brief)),
    changeCount: typedBrief.changeInventory.length,
    goalCount: typedBrief.goalAlignment.goals.length,
    outOfScopeCount: typedBrief.goalAlignment.outOfScope.length,
    planHash: hashText(stableStringify(planProjection(typedBrief))),
    verificationCount: typedBrief.verificationMatrix.length,
  };
};

export const guardMicroBriefFile = ({
  briefFile,
  patchFiles = [],
  repository = '',
  stage,
}: BriefFileOptions): MicroBriefSummary & { briefHash: string } => {
  const { content } = readWorkflowInputFile(briefFile, {
    allowedPrefix: `${workflowRelativePath('runtimeRoot', 'briefs')}/`,
    label: 'Micro Brief 文件',
    maxBytes: MAX_BRIEF_BYTES,
  });
  return guardMicroBriefContent({
    content,
    patchFiles,
    repository,
    stage,
  });
};
