import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { workspaceRoot } from './context-budget.js';
import { loadWorkflowPaths } from '../config/workflow-config.js';
import { errorMessage } from '../types/guards.js';

interface CandidateOptions {
  id: string;
  note: string;
  reviewer: string;
  signal: string;
  source: string;
  title: string;
}

interface CandidateContentOptions {
  createdAt?: string;
  id: string;
  signal: string;
  source: string;
  title: string;
}

interface KnowledgeDirectoryOptions {
  knowledgeDirectory?: string;
  silent?: boolean;
}

interface CandidateValidation {
  errors: string[];
  metadata: Record<string, string>;
}

interface PromotedCandidate {
  auditPath: string;
  targetPath: string;
}

const knowledgeRoot = loadWorkflowPaths().knowledgeRoot;
const CANDIDATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_VALUES = new Set([
  'manual',
  'route-feedback',
  'review',
  'tool-failure',
]);
const MAX_CANDIDATE_CHARS = 12000;
const STALE_LOCK_MS = 5 * 60 * 1000;
const REQUIRED_SECTIONS = [
  'Problem Signal',
  'Evidence',
  'Candidate Guidance',
  'Validation',
  'Reuse Boundary',
  'Human Review',
];
const PLACEHOLDER_PATTERN = /\bTODO\b|待补充|待验证|:\s*pending\s*$/im;
const SENSITIVE_PATTERNS = [
  /\b(?:password|passwd|token|cookie|authorization|secret|api[_-]?key)\b\s*[:=]\s*\S+/i,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/,
  /[?&](?:scode|access_token|sign)=\S+/i,
];

const assertCandidateId = (candidateId: string): void => {
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error('候选 ID 只能包含小写字母、数字和连字符');
  }
};

const assertOneLine = (value: string, label: string, maxChars: number): void => {
  const characters = Array.from(value || '');
  if (characters.length === 0 || characters.length > maxChars || /[\r\n]/.test(value)) {
    throw new Error(`${label} 必须是 1-${maxChars} 字符的单行文本`);
  }
};

const candidatePath = (
  candidateId: string,
  knowledgeDirectory = knowledgeRoot,
): string =>
  path.join(knowledgeDirectory, '_staging', `${candidateId}.md`);

const approvedPath = (
  candidateId: string,
  knowledgeDirectory = knowledgeRoot,
): string =>
  path.join(knowledgeDirectory, 'approved', `${candidateId}.md`);

const lockPath = (
  candidateId: string,
  knowledgeDirectory = knowledgeRoot,
): string =>
  path.join(knowledgeDirectory, '_locks', `${candidateId}.lock`);

const errorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : '';

const writeTextAtomically = (
  filePath: string,
  content: string,
  { replace = true }: { replace?: boolean } = {},
): void => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    if (replace) {
      renameSync(temporaryPath, filePath);
    } else {
      linkSync(temporaryPath, filePath);
      unlinkSync(temporaryPath);
    }
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
};

const staleOrReleasedLock = (filePath: string): boolean => {
  try {
    return Date.now() - statSync(filePath).mtimeMs > STALE_LOCK_MS;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return true;
    }
    throw error;
  }
};

const withCandidateLock = <T>(
  candidateId: string,
  knowledgeDirectory: string,
  action: () => T,
): T => {
  const filePath = lockPath(candidateId, knowledgeDirectory);
  const token = `${process.pid}:${randomUUID()}`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(filePath, 'wx');
      writeFileSync(descriptor, token, 'utf8');
      break;
    } catch (error: unknown) {
      const acquiredDescriptor = descriptor;
      const acquiredLock = acquiredDescriptor !== undefined;
      if (acquiredDescriptor !== undefined) {
        closeSync(acquiredDescriptor);
        descriptor = undefined;
      }
      if (errorCode(error) !== 'EEXIST') {
        if (acquiredLock) {
          try {
            unlinkSync(filePath);
          } catch (unlinkError: unknown) {
            if (errorCode(unlinkError) !== 'ENOENT') {
              throw unlinkError;
            }
          }
        }
        throw error;
      }
      if (attempt > 0 || !staleOrReleasedLock(filePath)) {
        throw new Error(`候选正在由另一进程处理：${candidateId}`);
      }
      try {
        unlinkSync(filePath);
      } catch (unlinkError: unknown) {
        if (errorCode(unlinkError) !== 'ENOENT') {
          throw unlinkError;
        }
      }
    }
  }
  if (descriptor === undefined) {
    throw new Error(`无法锁定候选：${candidateId}`);
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    try {
      if (readFileSync(filePath, 'utf8') === token) {
        unlinkSync(filePath);
      }
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
    }
  }
};

const findSection = (content: string, sectionName: string): string => {
  const headingPattern = new RegExp(`^## ${sectionName}\\r?$`, 'm');
  const heading = headingPattern.exec(content);
  if (!heading) {
    return '';
  }
  const bodyStart = heading.index + heading[0].length;
  const remaining = content.slice(bodyStart);
  const nextHeadingOffset = remaining.search(/^##\s/m);
  const bodyEnd = nextHeadingOffset < 0
    ? content.length
    : bodyStart + nextHeadingOffset;
  return content.slice(bodyStart, bodyEnd).trim();
};

const readMetadata = (content: string): Record<string, string> => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? '';
  return Object.fromEntries(
    frontmatter
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf(':');
        return separator < 0
          ? ['', '']
          : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
      .filter(([key]) => key),
  ) as Record<string, string>;
};

/** Detects credential-shaped values before knowledge is persisted. */
export const containsSensitiveData = (content: string): boolean =>
  SENSITIVE_PATTERNS.some((pattern) => pattern.test(content));

export const buildCandidateContent = ({
  createdAt = new Date().toISOString(),
  id,
  signal,
  source,
  title,
}: CandidateContentOptions): string => {
  assertCandidateId(id);
  assertOneLine(title, 'title', 120);
  assertOneLine(signal, 'signal', 500);
  if (!SOURCE_VALUES.has(source)) {
    throw new Error(`source 只支持：${[...SOURCE_VALUES].join(', ')}`);
  }
  if (containsSensitiveData(`${title}\n${signal}`)) {
    throw new Error('候选标题或问题信号疑似包含敏感凭据');
  }

  return [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'status: staging',
    `source: ${source}`,
    `created-at: ${createdAt}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Problem Signal',
    signal,
    '',
    '## Evidence',
    'TODO：补充可复核的代码、日志聚合或重复发生记录，不粘贴敏感原文。',
    '',
    '## Candidate Guidance',
    'TODO：描述可复用的处理规则、Skill 步骤或工具约束。',
    '',
    '## Validation',
    'TODO：记录至少一个已验证正例，以及必要的反例或失败边界。',
    '',
    '## Reuse Boundary',
    'TODO：说明适用项目、场景、版本和不适用范围。',
    '',
    '## Human Review',
    '- Sensitive Data Review: pending',
    '- Decision: pending',
    '- Reviewer:',
    '- Review Note:',
    '',
  ].join('\n');
};

/** Validates the candidate structure and optional human-approval gate. */
export const validateCandidateContent = (
  content: string,
  { requireApproval = true }: { requireApproval?: boolean } = {},
): CandidateValidation => {
  const errors: string[] = [];
  const metadata = readMetadata(content);
  const contentChars = Array.from(content).length;
  if (contentChars > MAX_CANDIDATE_CHARS) {
    errors.push(
      `候选为 ${contentChars} 字符，超过 ${MAX_CANDIDATE_CHARS} 字符上限`,
    );
  }
  if (!CANDIDATE_ID_PATTERN.test(metadata.id || '')) {
    errors.push('frontmatter 缺少合法 id');
  }
  if (metadata.status !== 'staging') {
    errors.push('候选 status 必须为 staging');
  }
  if (!SOURCE_VALUES.has(metadata.source ?? '')) {
    errors.push('候选 source 非法');
  }
  REQUIRED_SECTIONS.forEach((sectionName) => {
    const body = findSection(content, sectionName);
    if (!body) {
      errors.push(`缺少 ${sectionName} 小节`);
    } else if (sectionName !== 'Human Review' && PLACEHOLDER_PATTERN.test(body)) {
      errors.push(`${sectionName} 仍包含占位内容`);
    }
  });
  const humanReview = findSection(content, 'Human Review');
  if (!/^- Sensitive Data Review:\s*passed\s*$/m.test(humanReview)) {
    errors.push('Sensitive Data Review 必须为 passed');
  }
  if (requireApproval) {
    if (!/^- Decision:\s*approved\s*$/m.test(humanReview)) {
      errors.push('Decision 必须为 approved');
    }
    if (!/^- Reviewer:\s*\S.*$/m.test(humanReview)) {
      errors.push('Reviewer 必须记录人工审查者');
    }
  }
  if (containsSensitiveData(content)) {
    errors.push('候选内容疑似包含敏感凭据');
  }
  return {
    errors,
    metadata,
  };
};

export const lintCandidate = (
  candidateId: string,
  { knowledgeDirectory = knowledgeRoot, silent = false }: KnowledgeDirectoryOptions = {},
): CandidateValidation => {
  assertCandidateId(candidateId);
  const filePath = candidatePath(candidateId, knowledgeDirectory);
  if (!existsSync(filePath)) {
    throw new Error(`staging 候选不存在：${candidateId}`);
  }
  const validation = validateCandidateContent(
    readFileSync(filePath, 'utf8'),
    { requireApproval: false },
  );
  if (validation.errors.length > 0) {
    throw new Error(`候选草稿检查失败：${validation.errors.join('；')}`);
  }
  if (!silent) {
    process.stdout.write(`经验候选草稿检查通过：${candidateId}\n`);
  }
  return validation;
};

const readOptions = (args: string[]): CandidateOptions => {
  const options: CandidateOptions = {
    id: '',
    note: '',
    reviewer: '',
    signal: '',
    source: '',
    title: '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) {
      throw new Error('知识候选参数不能为空');
    }
    if (![
      '--id',
      '--note',
      '--reviewer',
      '--signal',
      '--source',
      '--title',
    ].includes(argument)) {
      throw new Error(`未知参数：${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} 缺少值`);
    }
    const key = argument.slice(2) as keyof CandidateOptions;
    options[key] = value;
    index += 1;
  }
  return options;
};

export const stageCandidate = (
  options: CandidateContentOptions,
  { knowledgeDirectory = knowledgeRoot, silent = false }: KnowledgeDirectoryOptions = {},
): string => {
  const content = buildCandidateContent(options);
  const filePath = candidatePath(options.id, knowledgeDirectory);
  withCandidateLock(options.id, knowledgeDirectory, () => {
    if (
      existsSync(filePath) ||
      existsSync(approvedPath(options.id, knowledgeDirectory))
    ) {
      throw new Error(`候选或正式知识已存在：${options.id}`);
    }
    writeTextAtomically(filePath, content, { replace: false });
  });
  if (!silent) {
    process.stdout.write(
      `经验候选已进入 staging：${path.relative(workspaceRoot, filePath)}\n`,
    );
  }
  return filePath;
};

export const checkCandidate = (
  candidateId: string,
  { knowledgeDirectory = knowledgeRoot, silent = false }: KnowledgeDirectoryOptions = {},
): CandidateValidation => {
  assertCandidateId(candidateId);
  const filePath = candidatePath(candidateId, knowledgeDirectory);
  if (!existsSync(filePath)) {
    throw new Error(`staging 候选不存在：${candidateId}`);
  }
  const validation = validateCandidateContent(readFileSync(filePath, 'utf8'));
  if (validation.errors.length > 0) {
    throw new Error(
      `候选尚不可晋升：${validation.errors.join('；')}`,
    );
  }
  if (!silent) {
    process.stdout.write(`经验候选晋升检查通过：${candidateId}\n`);
  }
  return validation;
};

const updateMetadata = (
  content: string,
  replacements: Record<string, string>,
  additions: string[] = [],
): string => {
  let updated = content;
  Object.entries(replacements).forEach(([key, value]) => {
    const pattern = new RegExp(`^${key}:.*$`, 'm');
    if (!pattern.test(updated)) {
      throw new Error(`frontmatter 缺少 ${key}`);
    }
    updated = updated.replace(pattern, `${key}: ${value}`);
  });
  if (additions.length > 0) {
    updated = updated.replace(
      /^---\r?\n([\s\S]*?)\r?\n---/,
      (_match, body) => `---\n${body}\n${additions.join('\n')}\n---`,
    );
  }
  return updated;
};

const promotedResult = (
  sourcePath: string,
  targetPath: string,
): PromotedCandidate => ({ auditPath: sourcePath, targetPath });

const approvedContentFromAudit = (auditContent: string): string =>
  updateMetadata(auditContent, { status: 'approved' })
    .replace(/^approved-path:.*(?:\r?\n|$)/m, '');

const promoteCandidateUnlocked = (
  candidateId: string,
  knowledgeDirectory: string,
): PromotedCandidate => {
  const sourcePath = candidatePath(candidateId, knowledgeDirectory);
  const targetPath = approvedPath(candidateId, knowledgeDirectory);
  if (!existsSync(sourcePath)) {
    throw new Error(`staging 候选不存在：${candidateId}`);
  }
  const original = readFileSync(sourcePath, 'utf8');
  const sourceMetadata = readMetadata(original);
  if (existsSync(targetPath)) {
    const targetContent = readFileSync(targetPath, 'utf8');
    const targetMetadata = readMetadata(targetContent);
    if (sourceMetadata.status === 'promoted') {
      const expectedPath = path.relative(workspaceRoot, targetPath).split(path.sep).join('/');
      if (targetMetadata.status !== 'approved' ||
          targetMetadata.id !== candidateId ||
          sourceMetadata.id !== candidateId ||
          !targetMetadata['promoted-at'] ||
          sourceMetadata['promoted-at'] !== targetMetadata['promoted-at'] ||
          sourceMetadata['approved-path'] !== expectedPath ||
          approvedContentFromAudit(original) !== targetContent) {
        throw new Error(`候选晋升状态不一致：${candidateId}`);
      }
      return promotedResult(sourcePath, targetPath);
    }
    const validation = validateCandidateContent(original);
    if (validation.errors.length > 0) {
      throw new Error(`候选尚不可恢复晋升：${validation.errors.join('；')}`);
    }
    const promotedAt = targetMetadata['promoted-at'] || '';
    const expectedApproved = promotedAt
      ? updateMetadata(original, { status: 'approved' }, [`promoted-at: ${promotedAt}`])
      : '';
    if (targetMetadata.status !== 'approved' ||
        targetMetadata.id !== candidateId ||
        expectedApproved !== targetContent) {
      throw new Error(`正式知识与 staging 候选不匹配：${candidateId}`);
    }
    const auditContent = updateMetadata(
      original,
      { status: 'promoted' },
      [
        `promoted-at: ${promotedAt}`,
        `approved-path: ${path.relative(workspaceRoot, targetPath).split(path.sep).join('/')}`,
      ],
    );
    writeTextAtomically(sourcePath, auditContent);
    return promotedResult(sourcePath, targetPath);
  }
  if (sourceMetadata.status === 'promoted') {
    throw new Error(`正式知识缺失但 staging 已标记 promoted：${candidateId}`);
  }
  const validation = validateCandidateContent(original);
  if (validation.errors.length > 0) {
    throw new Error(`候选尚不可晋升：${validation.errors.join('；')}`);
  }

  const promotedAt = new Date().toISOString();
  const approvedContent = updateMetadata(
    original,
    { status: 'approved' },
    [`promoted-at: ${promotedAt}`],
  );
  const auditContent = updateMetadata(
    original,
    { status: 'promoted' },
    [
      `promoted-at: ${promotedAt}`,
      `approved-path: ${path.relative(workspaceRoot, targetPath).split(path.sep).join('/')}`,
    ],
  );
  writeTextAtomically(targetPath, approvedContent, { replace: false });
  writeTextAtomically(sourcePath, auditContent);
  return promotedResult(sourcePath, targetPath);
};

export const promoteCandidate = (
  candidateId: string,
  { knowledgeDirectory = knowledgeRoot, silent = false }: KnowledgeDirectoryOptions = {},
): PromotedCandidate => {
  assertCandidateId(candidateId);
  const promoted = withCandidateLock(
    candidateId,
    knowledgeDirectory,
    () => promoteCandidateUnlocked(candidateId, knowledgeDirectory),
  );
  if (!silent) {
    process.stdout.write(
      `经验候选已由人工门禁晋升：${path.relative(workspaceRoot, promoted.targetPath)}\n`,
    );
  }
  return promoted;
};

const replaceReviewField = (
  content: string,
  field: string,
  value: string,
): string => {
  const pattern = new RegExp(`^(- ${field}:).*$`, 'm');
  if (!pattern.test(content)) {
    throw new Error(`Human Review 缺少 ${field}`);
  }
  return content.replace(pattern, (_match, prefix) => `${prefix} ${value}`);
};

export const approveCandidate = (
  candidateId: string,
  {
    knowledgeDirectory = knowledgeRoot,
    note = '用户在当前会话明确确认候选知识可晋升。',
    reviewer = 'conversation-user',
    silent = false,
  }: KnowledgeDirectoryOptions & { note?: string; reviewer?: string } = {},
): PromotedCandidate => {
  assertOneLine(reviewer, 'reviewer', 120);
  assertOneLine(note, 'note', 500);
  assertCandidateId(candidateId);
  const promoted = withCandidateLock(candidateId, knowledgeDirectory, () => {
    const sourcePath = candidatePath(candidateId, knowledgeDirectory);
    if (!existsSync(sourcePath)) {
      throw new Error(`staging 候选不存在：${candidateId}`);
    }
    const draft = readFileSync(sourcePath, 'utf8');
    if (readMetadata(draft).status === 'promoted' ||
        (existsSync(approvedPath(candidateId, knowledgeDirectory)) &&
          validateCandidateContent(draft).errors.length === 0)) {
      return promoteCandidateUnlocked(candidateId, knowledgeDirectory);
    }
    const draftValidation = validateCandidateContent(draft, { requireApproval: false });
    if (draftValidation.errors.length > 0) {
      throw new Error(`候选草稿尚不可批准：${draftValidation.errors.join('；')}`);
    }
    let approved = replaceReviewField(draft, 'Sensitive Data Review', 'passed');
    approved = replaceReviewField(approved, 'Decision', 'approved');
    approved = replaceReviewField(approved, 'Reviewer', reviewer);
    approved = replaceReviewField(approved, 'Review Note', note);
    const validation = validateCandidateContent(approved);
    if (validation.errors.length > 0) {
      throw new Error(`候选批准后检查失败：${validation.errors.join('；')}`);
    }
    writeTextAtomically(sourcePath, approved);
    return promoteCandidateUnlocked(candidateId, knowledgeDirectory);
  });
  if (!silent) {
    process.stdout.write(
      `候选已获当前会话用户确认并晋升：${path.relative(workspaceRoot, promoted.targetPath)}\n`,
    );
  }
  return promoted;
};

const usage = [
  'Usage:',
  '  agent-workflow knowledge stage --id <id> --title <title>',
  '    --source <manual|route-feedback|review|tool-failure> --signal <signal>',
  '  agent-workflow knowledge lint --id <id>',
  '  agent-workflow knowledge check --id <id>',
  '  agent-workflow knowledge approve --id <id>',
  '    [--reviewer <name>] [--note <note>]',
  '  agent-workflow knowledge promote --id <id>',
].join('\n');

export const main = (args: string[] = process.argv.slice(2)): number => {
  const [command, ...optionArgs] = args;
  try {
    const options = readOptions(optionArgs);
    if (command === 'stage') {
      stageCandidate(options);
      return 0;
    }
    if (command === 'check') {
      checkCandidate(options.id);
      return 0;
    }
    if (command === 'lint') {
      lintCandidate(options.id);
      return 0;
    }
    if (command === 'approve') {
      approveCandidate(options.id, {
        ...(options.note ? { note: options.note } : {}),
        ...(options.reviewer ? { reviewer: options.reviewer } : {}),
      });
      return 0;
    }
    if (command === 'promote') {
      promoteCandidate(options.id);
      return 0;
    }
    throw new Error(usage);
  } catch (error: unknown) {
    const message = errorMessage(error);
    process.stderr.write(`经验知识状态失败：${message}\n`);
    if (message !== usage) {
      process.stderr.write(`${usage}\n`);
    }
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
