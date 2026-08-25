import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  resolveWorkspaceRelativePath,
  workflowRelativePath,
} from '../config/workflow-config.js';
import {
  loadRoutes,
  workspaceRoot,
} from './context-budget.js';
import { MICRO_BRIEF_STAGES } from './micro-brief.js';
import type { RoutesConfig } from '../types/contracts.js';

interface RepositoryGuard {
  repository: string;
  repositoryId: string;
  repositoryRoot: string;
}

interface PatchFileHeader {
  newPath: string | null;
  newPathSeen: boolean;
  oldPath: string | null;
  oldPathSeen: boolean;
}

export interface MicroPatchAnalysis {
  blockers: string[];
  fileCount: number;
  files: string[];
  patchHash: string;
  semanticLines: number;
}

interface GitCommandOptions {
  args: string[];
  cwd: string;
}

interface GitCommandResult {
  error?: Error & { code?: string };
  signal?: string | null;
  status: number | null;
  stderr?: string;
  stdout?: string;
}

type GitRunner = (options: GitCommandOptions) => GitCommandResult;

export interface MicroRunEvent {
  changeType?: string;
  microBriefPlanHash?: string;
  microPatchHash?: string;
  microRepositoryId?: string;
  microSourceHash?: string | undefined;
  result: string;
  route: string;
  runId: string;
  stage: string;
}

interface MicroPatchGuard extends MicroPatchAnalysis {
  repository: string;
  repositoryCount: number;
  repositoryId: string;
  sourceHash: string;
  sourceMode: string;
}

export const MICRO_GUARD_STAGES = new Set([
  'review-defect',
  'review-requirement',
  'verify-defect',
  'verify-requirement',
  'git-inspect',
]);
const MAX_PATCH_BYTES = 200 * 1024;
const ALLOWED_METADATA = [
  /^(?:new|deleted) file mode /,
  /^(?:old|new) mode /,
  /^(?:dis)?similarity index /,
  /^(?:rename|copy) (?:from|to) /,
  /^index /,
];

const hashText = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const runGitCommand: GitRunner = ({ args, cwd }) => spawnSync(
  'git',
  ['--no-optional-locks', ...args],
  {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    windowsHide: true,
  },
);

const withTemporaryPatchFile = <T>(
  patch: string,
  action: (patchPath: string) => T,
): T => {
  const patchRoot = resolveWorkspaceRelativePath(
    workflowRelativePath('runtimeRoot', 'patches'),
    'Micro Change Source Gate 临时目录',
  );
  mkdirSync(patchRoot, { recursive: true });
  // A unique owned directory avoids Windows stdin pipe stalls and cleanup collisions.
  const temporaryDirectory = mkdtempSync(
    path.join(patchRoot, '.source-gate-'),
  );
  const patchPath = path.join(temporaryDirectory, 'input.patch');
  try {
    writeFileSync(patchPath, Buffer.from(patch, 'utf8'), { flag: 'wx' });
    return action(patchPath);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
};

const throwGitExecutionError = (
  operation: string,
  result: GitCommandResult,
): never => {
  const code = result.error?.code;
  const detail = code
    ? ` (${code})`
    : result.signal
      ? ` (${result.signal})`
      : '';
  if (code === 'ETIMEDOUT') {
    throw new Error(
      `Micro Change Source Gate: Git ${operation}执行超时${detail}；` +
      '请重试，持续发生时检查 Git 与本机进程环境',
    );
  }
  throw new Error(
    `Micro Change Source Gate: 无法执行 Git ${operation}${detail}；` +
    '请检查 Git 安装与本机进程环境',
  );
};

const assertGitExecutionCompleted = (
  operation: string,
  result: GitCommandResult,
): void => {
  if (result.error || result.status === null) {
    throwGitExecutionError(operation, result);
  }
};

export const guardMicroRepository = (
  repository: unknown,
  { required = true }: { required?: boolean } = {},
): RepositoryGuard | null => {
  if (typeof repository !== 'string' || !repository.trim()) {
    if (!required) {
      return null;
    }
    throw new Error('Micro Change 实际范围检查必须提供 --repository');
  }
  if (path.isAbsolute(repository)) {
    throw new Error('--repository 必须使用工作区相对路径');
  }
  const resolved = path.resolve(workspaceRoot, repository);
  const workspacePrefix = `${workspaceRoot}${path.sep}`;
  if (resolved !== workspaceRoot && !resolved.startsWith(workspacePrefix)) {
    throw new Error(`--repository 越界：${repository}`);
  }
  if (!existsSync(path.join(resolved, '.git'))) {
    throw new Error(`--repository 不是 Git 仓库：${repository}`);
  }
  const nativeRepository = path.relative(workspaceRoot, resolved) || '.';
  const normalizedRepository = nativeRepository
    .split(path.sep)
    .join('/');
  return {
    repository: normalizedRepository,
    // Keep the native-path hash compatible with existing Windows Run events.
    repositoryId: hashText(nativeRepository).slice(0, 12),
    repositoryRoot: resolved,
  };
};

const GIT_QUOTED_ESCAPES: Record<string, number> = {
  '"': 0x22,
  '\\': 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

const decodeGitQuotedPath = (value: string): string => {
  // Git quotes non-ASCII path bytes as C-style octal escapes, not Unicode escapes.
  const chunks: Buffer[] = [];
  let literal = '';
  const flushLiteral = (): void => {
    if (literal) {
      chunks.push(Buffer.from(literal, 'utf8'));
      literal = '';
    }
  };

  for (let index = 0; index < value.length;) {
    if (value[index] !== '\\') {
      literal += value[index];
      index += 1;
      continue;
    }
    flushLiteral();
    const octal = value.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      const byte = Number.parseInt(octal, 8);
      if (byte > 0xff) {
        throw new Error('Micro Change patch 包含非法 Git 路径转义');
      }
      chunks.push(Buffer.from([byte]));
      index += 4;
      continue;
    }
    const escaped = value[index + 1] ?? '';
    const byte = GIT_QUOTED_ESCAPES[escaped];
    if (byte === undefined) {
      throw new Error('Micro Change patch 包含非法 Git 路径转义');
    }
    chunks.push(Buffer.from([byte]));
    index += 2;
  }
  flushLiteral();
  const decoded = Buffer.concat(chunks).toString('utf8');
  if (decoded.includes('\uFFFD')) {
    throw new Error('Micro Change patch 的 Git 路径不是有效 UTF-8');
  }
  return decoded;
};

const normalizePatchPath = (
  value: string,
  expectedPrefix: string,
): string | null => {
  const trimmed = value.trim();
  if (trimmed === '/dev/null') {
    return null;
  }
  const quoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const normalized = quoted
    ? decodeGitQuotedPath(trimmed.slice(1, -1))
    : trimmed;
  if (!normalized.startsWith(expectedPrefix)) {
    throw new Error(
      `Micro Change patch 文件路径必须以 ${expectedPrefix} 开头`,
    );
  }
  const relativePath = normalized.slice(expectedPrefix.length);
  if (!relativePath || relativePath.includes('\\') ||
      /[\x00-\x1f\x7f]/.test(relativePath) ||
      relativePath.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Micro Change patch 包含非法或越界文件路径');
  }
  return normalized;
};

export const analyzeMicroChangePatch = (
  patch: unknown,
  gate: RoutesConfig['microChangeGate'] = loadRoutes().microChangeGate,
): MicroPatchAnalysis => {
  if (typeof patch !== 'string' || !patch.trim()) {
    throw new Error('Micro Change 实际范围检查未收到 unified diff');
  }
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    throw new Error(`Micro Change patch 超过 ${MAX_PATCH_BYTES} 字节上限`);
  }
  if (patch.includes('\0') || patch.includes('\uFFFD')) {
    throw new Error('Micro Change patch 必须是有效 UTF-8 文本');
  }
  if (/^(?:GIT binary patch|Binary files .* differ)$/m.test(patch)) {
    throw new Error('Micro Change 不接受二进制补丁');
  }
  if (/^[+-]Subproject commit [0-9a-f]+/m.test(patch)) {
    throw new Error('Micro Change 不接受子仓库指针变更');
  }

  const unifiedFiles = new Set<string>();
  let currentFile: PatchFileHeader | null = null;
  let inHunk = false;
  let newLinesRemaining = 0;
  let oldLinesRemaining = 0;
  let semanticLines = 0;

  const completeCurrentFile = (): void => {
    if (!currentFile) {
      return;
    }
    if (!currentFile.oldPathSeen || !currentFile.newPathSeen) {
      throw new Error('Micro Change patch 的文件头不完整');
    }
    const selectedPath = currentFile.newPath ?? currentFile.oldPath;
    if (!selectedPath) {
      throw new Error('Micro Change patch 的新旧文件路径不能同时为 /dev/null');
    }
    if (unifiedFiles.has(selectedPath)) {
      throw new Error(`Micro Change patch 重复声明文件：${selectedPath}`);
    }
    unifiedFiles.add(selectedPath);
  };

  patch.split(/\r?\n/).forEach((line) => {
    if (line.startsWith('diff --git ')) {
      if (inHunk) {
        throw new Error('Micro Change patch 的 hunk 行数与内容不一致');
      }
      completeCurrentFile();
      if (!line.slice('diff --git '.length).trim()) {
        throw new Error('Micro Change patch 的 diff --git 文件头为空');
      }
      currentFile = {
        newPath: null,
        newPathSeen: false,
        oldPath: null,
        oldPathSeen: false,
      };
      return;
    }
    if (line.startsWith('@@ ')) {
      if (!currentFile?.oldPathSeen || !currentFile.newPathSeen) {
        throw new Error('Micro Change patch 的 hunk 缺少完整文件头');
      }
      const hunk = line.match(
        /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/,
      );
      if (!hunk) {
        throw new Error('Micro Change 不接受无法解析的 unified diff hunk');
      }
      oldLinesRemaining = Number(hunk[1] ?? 1);
      newLinesRemaining = Number(hunk[2] ?? 1);
      inHunk = oldLinesRemaining > 0 || newLinesRemaining > 0;
      return;
    }
    if (inHunk) {
      if (line.startsWith('+')) {
        newLinesRemaining -= 1;
        semanticLines += 1;
      } else if (line.startsWith('-')) {
        oldLinesRemaining -= 1;
        semanticLines += 1;
      } else if (line.startsWith(' ')) {
        oldLinesRemaining -= 1;
        newLinesRemaining -= 1;
      } else if (!line.startsWith('\\ No newline at end of file')) {
        throw new Error('Micro Change patch 包含非法 hunk 行');
      }
      if (oldLinesRemaining < 0 || newLinesRemaining < 0) {
        throw new Error('Micro Change patch 的 hunk 行数超出声明');
      }
      if (oldLinesRemaining === 0 && newLinesRemaining === 0) {
        inHunk = false;
      }
      return;
    }
    if (line.startsWith('--- ')) {
      if (!currentFile || currentFile.oldPathSeen) {
        throw new Error('Micro Change patch 包含重复或孤立的旧文件头');
      }
      currentFile.oldPath = normalizePatchPath(line.slice(4), 'a/');
      currentFile.oldPathSeen = true;
      return;
    }
    if (line.startsWith('+++ ')) {
      if (!currentFile?.oldPathSeen || currentFile.newPathSeen) {
        throw new Error('Micro Change patch 包含重复或孤立的新文件头');
      }
      currentFile.newPath = normalizePatchPath(line.slice(4), 'b/');
      currentFile.newPathSeen = true;
      return;
    }
    if (!line || line.startsWith('\\ No newline at end of file')) {
      return;
    }
    if (!currentFile || !ALLOWED_METADATA.some((pattern) => pattern.test(line))) {
      throw new Error(`Micro Change patch 包含无法识别的结构行：${line}`);
    }
  });

  if (inHunk) {
    throw new Error('Micro Change patch 的 hunk 内容不完整');
  }
  completeCurrentFile();
  const fileCount = unifiedFiles.size;
  const blockers = [
    ...(fileCount < gate.minFiles || fileCount > gate.maxFiles
      ? [`actual-file-count:${fileCount}`]
      : []),
    ...(semanticLines < gate.minSemanticLines ||
        semanticLines > gate.maxSemanticLines
      ? [`actual-semantic-lines:${semanticLines}`]
      : []),
  ];
  return {
    blockers,
    fileCount,
    files: [...unifiedFiles]
      .map((filePath) => filePath.slice(2))
      .sort(),
    patchHash: hashText(patch).slice(0, 16),
    semanticLines,
  };
};

export const validateMicroChangeRun = ({
  allowNewRun = false,
  briefPlanHash = '',
  changeType,
  events,
  patchHash = '',
  repositoryId = '',
  runId,
  sourceHash = '',
  stage,
}: {
  allowNewRun?: boolean;
  briefPlanHash?: string;
  changeType: string | null;
  events: MicroRunEvent[];
  patchHash?: string;
  repositoryId?: string;
  runId: string;
  sourceHash?: string;
  stage: string;
}, config: RoutesConfig = loadRoutes()): void => {
  if (!changeType) {
    throw new Error('Micro Change Run Gate: 缺少变更类型');
  }
  const stagePath = config.routes['micro-change']?.stagePaths?.[changeType] || [];
  const stageIndex = stagePath.indexOf(stage);
  if (stageIndex < 0) {
    throw new Error(`Micro Change Run Gate: 未知阶段 ${stage}`);
  }
  if (MICRO_GUARD_STAGES.has(stage) &&
      (!/^[a-f0-9]{16}$/.test(patchHash) ||
       !/^[a-f0-9]{12}$/.test(repositoryId) ||
       !/^[a-f0-9]{16}$/.test(sourceHash))) {
    throw new Error(
      'Micro Change Run Gate: Review 起必须提供完整的 patch、仓库和来源绑定',
    );
  }
  if (MICRO_BRIEF_STAGES.has(stage) && !/^[a-f0-9]{16}$/.test(briefPlanHash)) {
    throw new Error(
      'Micro Change Run Gate: Implement 起必须提供有效的 Micro Brief 计划绑定',
    );
  }

  const runEvents = events.filter((event) =>
    event.runId === runId && event.result === 'success');
  if (runEvents.some((event) => event.route !== 'micro-change')) {
    throw new Error('Micro Change Run Gate: Run ID 已绑定其他 Route');
  }
  const microEvents = runEvents.filter((event) => event.route === 'micro-change');
  if (microEvents.some((event) => event.changeType !== changeType)) {
    throw new Error('Micro Change Run Gate: Run ID 的变更类型不一致');
  }

  if (stageIndex === 0) {
    if (!allowNewRun && !microEvents.some((event) => event.stage === stage)) {
      throw new Error('Micro Change Run Gate: 首阶段 Run ID 不存在');
    }
  } else {
    stagePath.slice(0, stageIndex).forEach((requiredStage) => {
      if (!microEvents.some((event) => event.stage === requiredStage)) {
        throw new Error(
          `Micro Change Run Gate: 缺少前置阶段 ${requiredStage}`,
        );
      }
    });
  }

  const futureStages = new Set(stagePath.slice(stageIndex + 1));
  if (microEvents.some((event) => futureStages.has(event.stage))) {
    throw new Error('Micro Change Run Gate: 不允许回退到已完成阶段之前');
  }

  const guardedEvents = microEvents.filter((event) =>
    event.microPatchHash && event.microPatchHash !== 'none');
  if (patchHash && guardedEvents.some((event) =>
    event.microPatchHash !== patchHash ||
    event.microRepositoryId !== repositoryId ||
    (event.microSourceHash &&
     event.microSourceHash !== 'none' &&
     event.microSourceHash !== sourceHash))) {
    throw new Error(
      'Micro Change Run Gate: 实际仓库、patch 或来源绑定已发生变化',
    );
  }
  const briefEvents = microEvents.filter((event) =>
    event.microBriefPlanHash && event.microBriefPlanHash !== 'none');
  if (briefPlanHash && briefEvents.some((event) =>
    event.microBriefPlanHash !== briefPlanHash)) {
    throw new Error('Micro Change Run Gate: Micro Brief 计划追踪已发生变化');
  }
};

export const verifyMicroPatchSource = ({
  patch,
  patchHash,
  repositoryId,
  repositoryRoot,
}: {
  patch: string;
  patchHash: string;
  repositoryId: string;
  repositoryRoot: string;
}, {
  runGit = runGitCommand,
}: { runGit?: GitRunner } = {}): { sourceHash: string; sourceMode: string } => {
  const reverseCheck = withTemporaryPatchFile(patch, (patchPath) => runGit({
    args: [
      'apply',
      '--reverse',
      '--check',
      '--whitespace=nowarn',
      '--',
      patchPath,
    ],
    cwd: repositoryRoot,
  }));
  assertGitExecutionCompleted('patch 校验', reverseCheck);
  if (reverseCheck.status !== 0) {
    throw new Error(
      'Micro Change Source Gate: patch 与仓库当前内容不一致；' +
      '请从当前任务改动重新生成 unified diff',
    );
  }

  const revisionResult = runGit({
    args: ['rev-parse', '--verify', 'HEAD'],
    cwd: repositoryRoot,
  });
  assertGitExecutionCompleted('HEAD 校验', revisionResult);
  const revision = revisionResult?.status === 0
    ? revisionResult.stdout?.trim().toLowerCase() ?? ''
    : '';
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)) {
    throw new Error(
      'Micro Change Source Gate: 无法确认仓库 HEAD；切换 standard-change/capture',
    );
  }

  return {
    sourceHash: hashText(
      `${repositoryId}\n${revision}\n${patchHash}`,
    ).slice(0, 16),
    sourceMode: 'repository-reverse-check',
  };
};

export const guardMicroChangePatch = (
  { patch, repository }: { patch: string; repository: string },
  config: RoutesConfig = loadRoutes(),
  dependencies: { runGit?: GitRunner } = {},
): MicroPatchGuard => {
  const repositoryGuard = guardMicroRepository(repository);
  if (!repositoryGuard) {
    throw new Error('Micro Change 实际范围检查必须提供 --repository');
  }
  const result = analyzeMicroChangePatch(patch, config.microChangeGate);
  if (result.blockers.length > 0) {
    throw new Error(
      `Micro Change 实际范围超出 Gate：${result.blockers.join(', ')}；` +
      '切换 standard-change/capture',
    );
  }
  const source = verifyMicroPatchSource({
    patch,
    patchHash: result.patchHash,
    repositoryId: repositoryGuard.repositoryId,
    repositoryRoot: repositoryGuard.repositoryRoot,
  }, dependencies);
  return {
    ...result,
    repository: repositoryGuard.repository,
    repositoryCount: config.microChangeGate.repositories,
    repositoryId: repositoryGuard.repositoryId,
    ...source,
  };
};
