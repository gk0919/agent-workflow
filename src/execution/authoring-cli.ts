import { randomBytes } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  WORKFLOW_DEFINITION_SOURCES,
  WORKFLOW_EXECUTION_MODES,
  type WorkflowDefinitionSource,
  type WorkflowExecutionMode,
} from '../contracts/execution.js';
import { serializeCanonicalJson } from '../core/execution-plan.js';
import { errorMessage } from '../types/guards.js';
import {
  createWorkflowDefinitionBundle,
  migrateWorkflowDefinitionArtifact,
  previewWorkflowDefinition,
} from './workflow-authoring.js';

const MAX_AUTHORING_FILE_BYTES = 512 * 1024;
type AuthoringAction = 'migrate' | 'preview' | 'save';
type WorkspacePathResolver = (relativePath: unknown, label?: string) => string;

const resolveInput = (
  requestedPath: string,
  resolveWorkspacePath: WorkspacePathResolver,
): string => {
  const resolved = resolveWorkspacePath(requestedPath, '--file');
  const stats = statSync(resolved);
  if (!stats.isFile() || path.extname(resolved).toLowerCase() !== '.json') {
    throw new Error('--file 必须指向工作区内的 .json 文件');
  }
  if (stats.size > MAX_AUTHORING_FILE_BYTES) {
    throw new Error(`--file 超过 ${MAX_AUTHORING_FILE_BYTES} 字节上限`);
  }
  return resolved;
};

const readInput = (
  requestedPath: string,
  resolveWorkspacePath: WorkspacePathResolver,
): unknown => JSON.parse(
  readFileSync(resolveInput(requestedPath, resolveWorkspacePath), 'utf8'),
) as unknown;

const resolveOutput = (
  requestedPath: string,
  resolveWorkspacePath: WorkspacePathResolver,
): string => {
  if (path.extname(requestedPath).toLowerCase() !== '.json') {
    throw new Error('--output 必须使用 .json 扩展名');
  }
  const resolved = resolveWorkspacePath(requestedPath, '--output');
  if (existsSync(resolved)) {
    throw new Error('--output 已存在；版本化 Workflow 不允许静默覆盖');
  }
  mkdirSync(path.dirname(resolved), { recursive: true });
  const revalidated = resolveWorkspacePath(requestedPath, '--output');
  if (revalidated !== resolved) {
    throw new Error('--output 在目录创建后发生漂移');
  }
  return revalidated;
};

const writeOutput = (
  requestedPath: string,
  value: unknown,
  resolveWorkspacePath: WorkspacePathResolver,
): string => {
  const outputPath = resolveOutput(requestedPath, resolveWorkspacePath);
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, `${serializeCanonicalJson(value)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    linkSync(temporaryPath, outputPath);
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
  return outputPath;
};

const positiveInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2147483647) {
    throw new Error('--version 必须是正整数');
  }
  return parsed;
};

const renderPreview = (preview: ReturnType<typeof previewWorkflowDefinition>): string => [
  `Workflow: ${preview.workflowId}`,
  `Mode: ${preview.executionMode}`,
  `Definition Hash: ${preview.workflowHash}`,
  `Preview Hash: ${preview.previewHash}`,
  `Nodes: ${preview.budget.nodeCount}`,
  `Max Executor Calls: ${preview.budget.maxExecutorCalls}`,
  `Permissions: ${preview.requirements.permissions.join(', ') || 'none'}`,
  `Repositories: ${preview.requirements.repositories.join(', ') || 'none'}`,
  `Effects: ${preview.effects.map((effect) => `${effect.nodeId}:${effect.kind}`).join(', ') || 'none'}`,
  '',
].join('\n');

const printUsage = (): void => {
  process.stdout.write([
    'Usage:',
    '  agent-workflow execution:author:preview --file <definition-or-bundle.json> [--mode serial|parallel-readonly|writable-worktree] [--format text|json]',
    '  agent-workflow execution:author:save --file <definition-or-bundle.json> --output <bundle.json> --version <n> [--source model|builder|human|migration] [--previous-version <n> --previous-hash <sha256>]',
    '  agent-workflow execution:author:migrate --file <legacy-or-bundle.json> --output <bundle.json> [--version <n>]',
    '',
  ].join('\n'));
};

export const main = async (args = process.argv.slice(2)): Promise<number> => {
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        file: { type: 'string' },
        format: { type: 'string', default: 'text' },
        help: { type: 'boolean', short: 'h' },
        mode: { type: 'string', default: 'parallel-readonly' },
        output: { type: 'string' },
        'previous-hash': { type: 'string' },
        'previous-version': { type: 'string' },
        source: { type: 'string', default: 'human' },
        version: { type: 'string' },
      },
      strict: true,
    });
    if (parsed.values.help) {
      printUsage();
      return 0;
    }
    const action = parsed.positionals[0] as AuthoringAction | undefined;
    if (!action || !['migrate', 'preview', 'save'].includes(action) ||
        parsed.positionals.length !== 1) {
      throw new Error('缺少或不支持 authoring action');
    }
    if (!parsed.values.file) {
      throw new Error(`${action} 必须提供 --file`);
    }
    const { resolveWorkspaceRelativePath } = await import('../config/workflow-config.js');
    const value = readInput(parsed.values.file, resolveWorkspaceRelativePath);
    if (action === 'preview') {
      if (!WORKFLOW_EXECUTION_MODES.includes(parsed.values.mode as WorkflowExecutionMode)) {
        throw new Error('--mode 不受支持');
      }
      if (parsed.values.format !== 'text' && parsed.values.format !== 'json') {
        throw new Error('--format 仅支持 text 或 json');
      }
      const preview = previewWorkflowDefinition(
        value,
        parsed.values.mode as WorkflowExecutionMode,
      );
      process.stdout.write(parsed.values.format === 'json'
        ? `${serializeCanonicalJson(preview)}\n`
        : renderPreview(preview));
      return 0;
    }
    if (!parsed.values.output) {
      throw new Error(`${action} 必须提供 --output`);
    }
    const version = positiveInteger(parsed.values.version, 1);
    const bundle = action === 'migrate'
      ? migrateWorkflowDefinitionArtifact(value, { version })
      : (() => {
        if (!WORKFLOW_DEFINITION_SOURCES.includes(
          parsed.values.source as WorkflowDefinitionSource,
        )) {
          throw new Error('--source 不受支持');
        }
        const previousVersion = parsed.values['previous-version'];
        const previousHash = parsed.values['previous-hash'];
        if (Boolean(previousVersion) !== Boolean(previousHash)) {
          throw new Error('--previous-version 和 --previous-hash 必须同时提供');
        }
        return createWorkflowDefinitionBundle(value, {
          ...(previousVersion && previousHash
            ? {
              previousVersion: {
                definitionHash: previousHash,
                version: positiveInteger(previousVersion, 1),
              },
            }
            : {}),
          source: parsed.values.source as WorkflowDefinitionSource,
          version,
        });
      })();
    const outputPath = writeOutput(
      parsed.values.output,
      bundle,
      resolveWorkspaceRelativePath,
    );
    const { workspaceRoot } = await import('../config/workspace-paths.js');
    process.stdout.write([
      `Workflow: ${bundle.workflowId}`,
      `Version: ${bundle.version}`,
      `Definition Hash: ${bundle.definitionHash}`,
      `Saved: ${path.relative(workspaceRoot, outputPath).split(path.sep).join('/')}`,
      '',
    ].join('\n'));
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`Workflow authoring ${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
