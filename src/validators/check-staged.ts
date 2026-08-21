import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadActiveProfile,
  workflowRelativePath,
} from '../config/workflow-config.js';
import {
  analyzeJavaScriptPatch,
  findRepositoryRoot,
  getAddedLines,
  runGit,
} from './check-js-diff.js';
import { errorMessage } from '../types/guards.js';

const FORBIDDEN_PATHS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)node_modules\//i,
  /\.(?:log|tmp|bak|swp)$/i,
  /(^|\/)(?:Thumbs\.db|\.DS_Store)$/i,
];
const PROFILE_FORBIDDEN_PATHS = loadActiveProfile()
  .governance.forbiddenStagedPatterns
  .map((pattern) => new RegExp(pattern, 'i'));
const LOCAL_WORKFLOW_PREFIXES = [
  workflowRelativePath('tasksRoot'),
  workflowRelativePath('runtimeRoot', 'logs'),
].map((relativePath) => relativePath.replaceAll('\\', '/'));

const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /[?&](?:X-Amz-Signature|Signature|AccessKeyId)=[^&\s]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const isJavaScript = (filePath: string): boolean =>
  ['.js', '.mjs', '.cjs'].includes(path.extname(filePath).toLowerCase());

const readIndexFile = (repositoryRoot: string, filePath: string): Buffer => {
  const result = runGit(['show', `:${filePath}`], repositoryRoot, null);
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString('utf8').trim() || `无法读取暂存文件 ${filePath}`);
  }
  return result.stdout;
};

const listStagedFiles = (repositoryRoot: string): string[] => {
  const result = runGit([
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMR',
    '-z',
  ], repositoryRoot, null);

  if (result.status !== 0) {
    throw new Error(result.stderr?.toString('utf8').trim() || '无法读取暂存文件列表');
  }

  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
};

const getStagedPatch = (repositoryRoot: string, filePath: string): string => {
  const result = runGit(['diff', '--cached', '--unified=0', '--', filePath], repositoryRoot);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `无法读取 ${filePath} 的暂存差异`);
  }
  return result.stdout;
};

export const main = (): number => {
  const repositoryRoot = findRepositoryRoot();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!repositoryRoot) {
    process.stderr.write('提交前检查失败：当前目录不属于 Git 仓库。\n');
    return 1;
  }

  let files: string[];
  try {
    files = listStagedFiles(repositoryRoot);
  } catch (error: unknown) {
    process.stderr.write(`提交前检查失败：${errorMessage(error)}\n`);
    return 1;
  }

  if (files.length === 0) {
    process.stdout.write('提交前检查通过：没有暂存文件。\n');
    return 0;
  }

  files.forEach((filePath) => {
    const isEnvironmentExample = /(^|\/)\.env\.example$/i.test(filePath);
    const forbiddenPaths = [...FORBIDDEN_PATHS, ...PROFILE_FORBIDDEN_PATHS];
    const normalizedPath = filePath.replaceAll('\\', '/');
    const isLocalWorkflowData = LOCAL_WORKFLOW_PREFIXES.some((prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`));
    if (!isEnvironmentExample &&
        (isLocalWorkflowData || forbiddenPaths.some((pattern) => pattern.test(filePath)))) {
      errors.push(`${filePath}: 文件类型或路径禁止提交`);
    }

    let buffer: Buffer;
    let patch: string;
    try {
      buffer = readIndexFile(repositoryRoot, filePath);
      patch = getStagedPatch(repositoryRoot, filePath);
    } catch (error: unknown) {
      errors.push(`${filePath}: ${errorMessage(error)}`);
      return;
    }

    if (buffer.includes(0)) {
      return;
    }

    const content = buffer.toString('utf8');
    if (content.includes('\uFFFD')) {
      errors.push(`${filePath}: 文件不是有效 UTF-8，或包含无法解码的字节`);
    }

    if (buffer.length > 0 && !content.endsWith('\n')) {
      errors.push(`${filePath}: 文件末尾缺少换行`);
    }

    if (path.extname(filePath).toLowerCase() === '.json') {
      try {
        JSON.parse(content);
      } catch (error: unknown) {
        errors.push(`${filePath}: JSON 语法错误（${errorMessage(error)}）`);
      }
    }

    const additions = getAddedLines(patch);
    additions.forEach(({ lineNumber, text }) => {
      if (/^(?:<{7}|={7}|>{7})(?:\s|$)/.test(text)) {
        errors.push(`${filePath}:${lineNumber}: 存在未解决的 Git 冲突标记`);
      }

      if (/[ \t]+$/.test(text)) {
        errors.push(`${filePath}:${lineNumber}: 存在行尾空格`);
      }

      if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
        errors.push(`${filePath}:${lineNumber}: 疑似包含密钥、令牌、密码或签名 URL`);
      }
    });

    if (isJavaScript(filePath)) {
      const jsResult = analyzeJavaScriptPatch(filePath, patch);
      errors.push(...jsResult.errors);
      warnings.push(...jsResult.warnings);
    }
  });

  errors.forEach((message) => process.stderr.write(`ERROR: ${message}\n`));
  warnings.forEach((message) => process.stderr.write(`WARNING: ${message}\n`));

  if (errors.length > 0) {
    process.stderr.write(`提交前检查失败：${errors.length} 个阻断项。\n`);
    return 1;
  }

  process.stdout.write(`提交前检查通过：检查 ${files.length} 个暂存文件，${warnings.length} 个警告。\n`);
  return 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
