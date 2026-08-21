import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { workflowRelativePath } from '../config/workflow-config.js';
import { readWorkflowInputFile } from '../core/workflow-input.js';
import type { UnknownRecord } from '../types/contracts.js';
import { errorMessage, isJsonObject } from '../types/guards.js';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

export interface AddedLine {
  lineNumber: number;
  text: string;
}

export interface PatchAnalysis {
  errors: string[];
  warnings: string[];
}

interface WorkingTreePatch {
  patch: string;
  relativePath: string;
}

export function runGit(
  args: string[],
  cwd: string,
  encoding: null,
): SpawnSyncReturns<Buffer>;
export function runGit(
  args: string[],
  cwd: string,
  encoding?: BufferEncoding,
): SpawnSyncReturns<string>;
export function runGit(
  args: string[],
  cwd: string,
  encoding: BufferEncoding | null = 'utf8',
): SpawnSyncReturns<Buffer | string> {
  return spawnSync('git', args, {
    cwd,
    encoding,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
}

export const findRepositoryRoot = (startPath: string = process.cwd()): string => {
  const startDirectory = existsSync(startPath) && statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);
  const result = runGit(['rev-parse', '--show-toplevel'], startDirectory);
  return result.status === 0 ? result.stdout.trim() : '';
};

export const normalizeGitPath = (filePath: string): string =>
  filePath.split(path.sep).join('/');

export const getAddedLines = (patch: string): AddedLine[] => {
  const lines = patch.split(/\r?\n/);
  const additions: AddedLine[] = [];
  let inHunk = false;
  let targetLine = 0;

  lines.forEach((line) => {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      return;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      inHunk = true;
      targetLine = Number(hunk[1] ?? 0);
      return;
    }

    if (!inHunk || line.startsWith('\\')) {
      return;
    }

    if (line.startsWith('+')) {
      additions.push({ lineNumber: targetLine, text: line.slice(1) });
      targetLine += 1;
      return;
    }

    if (!line.startsWith('-')) {
      targetLine += 1;
    }
  });

  return additions;
};

const scrubStringsAndComments = (line: string): string => line
  .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')
  .replace(/\/(?:\\.|[^/\r\n])+\/[dgimsuvy]*/g, '')
  .replace(/\/\/.*$/, '');

const isLooseEquality = (line: string): boolean => {
  const code = scrubStringsAndComments(line);
  const hasLooseOperator = /(^|[^=!])==([^=]|$)|(^|[^!])!=([^=]|$)/.test(code);
  const isIntentionalNullCheck = /\b(?:null|undefined)\s*==|==\s*(?:null|undefined)\b/.test(code);
  return hasLooseOperator && !isIntentionalNullCheck;
};

const collectMatches = (
  lines: AddedLine[],
  predicate: (line: AddedLine, index: number, lines: AddedLine[]) => unknown,
  limit = 5,
): string[] => lines
  .filter(predicate)
  .slice(0, limit)
  .map(({ lineNumber, text }) => `${lineNumber}: ${text.trim()}`);

const isBareWorkComment = (text: string): boolean => (
  /(?:\/\/|\/\*+|\*)\s*(?:TODO|FIXME)\b\s*:?\s*(?:\*\/)?\s*$/i.test(text)
);

const COMMENTED_CODE_PATTERNS = [
  /^(?:const|let|var)\s+[$\w]+\s*=/,
  /^(?:async\s+)?function\s+[$\w]+\s*\(/,
  /^class\s+[$\w]+(?:\s+extends\s+[$\w.]+)?\s*\{/,
  /^(?:if|for|while|switch)\s*\([^)]*\)\s*\{?\s*$/,
  /^(?:return|throw)\b.*;\s*$/,
  /^(?:import|export)\s+.*;\s*$/,
];

const isCommentedOutCode = (text: string): boolean => {
  const comment = text.match(/^\s*\/\/\s*(.+)$/)?.[1] ?? '';
  return COMMENTED_CODE_PATTERNS.some((pattern) => pattern.test(comment));
};

const isExportedApiDeclaration = (text: string): boolean => (
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\b/.test(text) ||
  /^\s*export\s+(?:const|let)\s+[$\w]+\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[$\w]+\s*=>)/.test(text)
);

const hasAdjacentAddedJsDoc = (lines: AddedLine[], index: number): boolean => {
  const currentLine = lines[index]?.lineNumber ?? 0;
  const nearbyLines = lines
    .slice(Math.max(0, index - 6), index)
    .filter(({ lineNumber }) => currentLine - lineNumber <= 6)
    .map(({ text }) => text)
    .join('\n');
  return /\/\*\*[\s\S]*\*\/\s*$/.test(nearbyLines);
};

export const analyzeJavaScriptPatch = (
  filePath: string,
  patch: string,
): PatchAnalysis => {
  const addedLines = getAddedLines(patch);
  const errors: string[] = [];
  const warnings: string[] = [];
  const varMatches = collectMatches(
    addedLines,
    ({ text }) => /^\s*var(?:\s+|[,;])/.test(text),
  );
  const equalityMatches = collectMatches(
    addedLines,
    ({ text }) => isLooseEquality(text),
  );
  const bareWorkCommentMatches = collectMatches(
    addedLines,
    ({ text }) => isBareWorkComment(text),
  );
  const commentedCodeMatches = collectMatches(
    addedLines,
    ({ text }) => isCommentedOutCode(text),
  );
  const undocumentedExportMatches = collectMatches(
    addedLines,
    ({ text }, index) => (
      isExportedApiDeclaration(text) &&
      !hasAdjacentAddedJsDoc(addedLines, index)
    ),
  );

  if (varMatches.length > 0) {
    errors.push(`${filePath}: 增量代码禁止使用 var，请改为 const 或 let\n  ${varMatches.join('\n  ')}`);
  }

  if (equalityMatches.length > 0) {
    errors.push(`${filePath}: 非空值判断禁止新增 == 或 !=，请使用 === 或 !==\n  ${equalityMatches.join('\n  ')}`);
  }

  if (bareWorkCommentMatches.length > 0) {
    warnings.push(
      `${filePath}: 新增 TODO/FIXME 缺少原因或跟踪信息，请补充说明或移除\n  ` +
      bareWorkCommentMatches.join('\n  '),
    );
  }

  if (commentedCodeMatches.length > 0) {
    warnings.push(
      `${filePath}: 疑似新增注释掉的旧代码，请删除或改写为原因/约束说明\n  ` +
      commentedCodeMatches.join('\n  '),
    );
  }

  if (undocumentedExportMatches.length > 0) {
    warnings.push(
      `${filePath}: 新增导出函数/类未在同一 patch 中附带 JSDoc，` +
      `请确认公共契约已有准确说明\n  ${undocumentedExportMatches.join('\n  ')}`,
    );
  }

  const addedText = addedLines.map(({ text }) => text).join('\n');
  const count = (pattern: RegExp): number => addedText.match(pattern)?.length ?? 0;
  const onCount = count(/\.on\s*\(/g);
  const unCount = count(/\.un\s*\(/g);
  const setIntervalCount = count(/\bsetInterval\s*\(/g);
  const clearIntervalCount = count(/\bclearInterval\s*\(/g);
  const setTimeoutCount = count(/\bsetTimeout\s*\(/g);
  const clearTimeoutCount = count(/\bclearTimeout\s*\(/g);

  if (onCount > unCount) {
    warnings.push(`${filePath}: 新增 on() ${onCount} 处、un() ${unCount} 处，请确认组件销毁时已解绑`);
  }

  if (setIntervalCount > clearIntervalCount) {
    warnings.push(`${filePath}: 新增 setInterval() ${setIntervalCount} 处、clearInterval() ${clearIntervalCount} 处，请确认已清理`);
  }

  if (setTimeoutCount > clearTimeoutCount) {
    warnings.push(`${filePath}: 新增 setTimeout() ${setTimeoutCount} 处、clearTimeout() ${clearTimeoutCount} 处，请确认可取消的定时器已清理`);
  }

  return { errors, warnings };
};

const countPatchChanges = (patch: string): number => patch
  .split(/\r?\n/)
  .filter((line) => (
    (line.startsWith('+') && !line.startsWith('+++')) ||
    (line.startsWith('-') && !line.startsWith('---'))
  ))
  .length;

export const analyzePatchHygiene = (
  filePath: string,
  rawPatch: string,
  semanticPatch: string,
): PatchAnalysis => {
  const rawChanges = countPatchChanges(rawPatch);
  const semanticChanges = countPatchChanges(semanticPatch);
  const excessiveFormattingChanges = rawChanges >= 40 &&
    rawChanges >= semanticChanges + 20 &&
    rawChanges >= Math.max(semanticChanges * 4, 40);

  if (!excessiveFormattingChanges) {
    return { errors: [], warnings: [] };
  }

  return {
    errors: [
      `${filePath}: 原始 diff ${rawChanges} 行、忽略行尾后 ${semanticChanges} 行，` +
      '疑似整文件换行符或格式污染；请恢复原格式后再提交',
    ],
    warnings: [],
  };
};

export const createPatchForNewFile = (
  content: string,
  relativePath: string,
): string => {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
};

export const getWorkingTreePatch = (
  absoluteFilePath: string,
  repositoryRoot: string,
  { ignoreSpaceAtEol = false }: { ignoreSpaceAtEol?: boolean } = {},
): WorkingTreePatch => {
  const relativePath = normalizeGitPath(path.relative(repositoryRoot, absoluteFilePath));
  const tracked = runGit(['ls-files', '--error-unmatch', '--', relativePath], repositoryRoot);

  if (tracked.status !== 0 && tracked.status !== 1) {
    throw new Error(tracked.stderr.trim() || `无法确认文件跟踪状态：${relativePath}`);
  }

  if (tracked.status !== 0) {
    return {
      relativePath,
      patch: createPatchForNewFile(
        readFileSync(absoluteFilePath, 'utf8'),
        relativePath,
      ),
    };
  }

  const diffArgs = ['diff'];
  if (ignoreSpaceAtEol) {
    diffArgs.push('--ignore-space-at-eol');
  }
  diffArgs.push('--unified=0', 'HEAD', '--', relativePath);
  const diff = runGit(diffArgs, repositoryRoot);
  if (diff.status !== 0) {
    throw new Error(diff.stderr.trim() || `无法读取工作区差异：${relativePath}`);
  }
  return { relativePath, patch: diff.stdout };
};

const readArgumentValue = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] ?? '' : '';
  return value.startsWith('--') ? '' : value;
};

const readHookInput = (): UnknownRecord | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(0, 'utf8'));
    return isJsonObject(value) ? value : null;
  } catch (error: unknown) {
    process.stderr.write(`JS 增量检查跳过：无法解析 Hook 输入（${errorMessage(error)}）\n`);
    return null;
  }
};

const report = (
  { errors, warnings }: PatchAnalysis,
  hookMode = false,
): number => {
  errors.forEach((message) => process.stderr.write(`ERROR: ${message}\n`));
  warnings.forEach((message) => process.stderr.write(`WARNING: ${message}\n`));

  if (errors.length > 0) {
    return hookMode ? 2 : 1;
  }

  if (warnings.length > 0) {
    process.stderr.write('JS 增量检查通过，但存在需要人工 Review 的警告。\n');
  } else {
    process.stdout.write('JS 增量检查通过。\n');
  }

  return 0;
};

const getWorkingTreeReport = (
  absoluteFilePath: string,
  repositoryRoot: string,
): PatchAnalysis => {
  const rawDiff = getWorkingTreePatch(absoluteFilePath, repositoryRoot);
  const semanticDiff = getWorkingTreePatch(
    absoluteFilePath,
    repositoryRoot,
    { ignoreSpaceAtEol: true },
  );
  const result = analyzeJavaScriptPatch(semanticDiff.relativePath, semanticDiff.patch);
  const hygieneResult = analyzePatchHygiene(
    semanticDiff.relativePath,
    rawDiff.patch,
    semanticDiff.patch,
  );
  result.errors.push(...hygieneResult.errors);
  result.warnings.push(...hygieneResult.warnings);
  return result;
};

const checkHookFile = (): number => {
  const input = readHookInput();
  const toolInput = isJsonObject(input?.tool_input) ? input.tool_input : {};
  const inputFilePath = toolInput.file_path;
  const filePath = typeof inputFilePath === 'string' ? inputFilePath : '';

  if (!filePath || !JS_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return 0;
  }

  const absoluteFilePath = path.resolve(filePath);
  const repositoryRoot = findRepositoryRoot(absoluteFilePath);

  if (!repositoryRoot) {
    process.stderr.write('JS 增量检查跳过：目标文件不属于 Git 仓库。\n');
    return 0;
  }

  try {
    return report(getWorkingTreeReport(absoluteFilePath, repositoryRoot), true);
  } catch (error: unknown) {
    process.stderr.write(`JS 增量检查失败：${errorMessage(error)}\n`);
    return 2;
  }
};

const checkWorkingTreeFile = (filePath: string): number => {
  if (!filePath) {
    process.stderr.write('JS 增量检查失败：--file 缺少文件路径。\n');
    return 1;
  }

  const absoluteFilePath = path.resolve(filePath);
  if (!existsSync(absoluteFilePath) || !statSync(absoluteFilePath).isFile()) {
    process.stderr.write(`JS 增量检查失败：文件不存在 ${filePath}\n`);
    return 1;
  }

  if (!JS_EXTENSIONS.has(path.extname(absoluteFilePath).toLowerCase())) {
    process.stderr.write(`JS 增量检查失败：不支持的文件类型 ${filePath}\n`);
    return 1;
  }

  const repositoryRoot = findRepositoryRoot(absoluteFilePath);
  if (!repositoryRoot) {
    process.stderr.write(`JS 增量检查失败：目标文件不属于 Git 仓库 ${filePath}\n`);
    return 1;
  }

  try {
    return report(getWorkingTreeReport(absoluteFilePath, repositoryRoot));
  } catch (error: unknown) {
    process.stderr.write(`JS 增量检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const checkPatchContent = (
  patch: string,
  label: string,
  source: string,
): number => {
  if (!patch.trim()) {
    process.stderr.write(`JS 增量检查失败：${source} 未收到 unified diff。\n`);
    return 1;
  }

  return report(analyzeJavaScriptPatch(label || 'patch-input.js', patch));
};

const checkPatchInput = (label: string): number => checkPatchContent(
  readFileSync(0, 'utf8'),
  label,
  '--patch-stdin',
);

const checkPatchFile = (patchFile: string, label: string): number => {
  try {
    const { content } = readWorkflowInputFile(patchFile, {
      allowedPrefix: `${workflowRelativePath('runtimeRoot', 'patches')}/`,
      label: 'JS patch 文件',
      maxBytes: 200 * 1024,
    });
    return checkPatchContent(content, label, '--patch-file');
  } catch (error: unknown) {
    process.stderr.write(`JS 增量检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const checkStagedJavaScript = (): number => {
  const repositoryRoot = findRepositoryRoot();
  if (!repositoryRoot) {
    process.stderr.write('JS 增量检查失败：当前目录不属于 Git 仓库。\n');
    return 1;
  }

  const list = runGit([
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMR',
    '--',
    '*.mjs',
    '*.js',
    '*.cjs',
  ], repositoryRoot);

  if (list.status !== 0) {
    process.stderr.write(`JS 增量检查失败：${list.stderr.trim()}\n`);
    return 1;
  }

  const files = list.stdout.split(/\r?\n/).filter(Boolean);
  const result: PatchAnalysis = { errors: [], warnings: [] };

  files.forEach((filePath) => {
    const diff = runGit(['diff', '--cached', '--unified=0', '--', filePath], repositoryRoot);
    if (diff.status !== 0) {
      result.errors.push(
        `${filePath}: 无法读取暂存区差异（${diff.stderr.trim() || '未知 Git 错误'}）`,
      );
      return;
    }
    const fileResult = analyzeJavaScriptPatch(filePath, diff.stdout);
    result.errors.push(...fileResult.errors);
    result.warnings.push(...fileResult.warnings);
  });

  return report(result);
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  const selectedModes = [
    '--hook-input',
    '--file',
    '--patch-stdin',
    '--patch-file',
    '--staged',
  ].filter((mode) => args.includes(mode));
  if (selectedModes.length > 1) {
    process.stderr.write(
      `JS 增量检查失败：检查模式不能同时使用（${selectedModes.join(', ')}）。\n`,
    );
    return 1;
  }

  if (args.includes('--hook-input')) {
    return checkHookFile();
  }

  if (args.includes('--file')) {
    return checkWorkingTreeFile(readArgumentValue(args, '--file'));
  }

  if (args.includes('--patch-stdin')) {
    return checkPatchInput(readArgumentValue(args, '--label'));
  }

  if (args.includes('--patch-file')) {
    return checkPatchFile(
      readArgumentValue(args, '--patch-file'),
      readArgumentValue(args, '--label'),
    );
  }

  if (args.includes('--staged')) {
    return checkStagedJavaScript();
  }

  process.stderr.write([
    'Usage:',
    '  agent-workflow quality:js --hook-input',
    '  agent-workflow quality:js --file <path>',
    '  agent-workflow quality:js --patch-stdin --label <path>',
    '  agent-workflow quality:js --patch-file <path> --label <path>',
    '  agent-workflow quality:js --staged',
    '',
  ].join('\n'));
  return 1;
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
