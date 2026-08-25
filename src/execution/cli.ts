import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { ExecutionControlResult, ExecutionRunResult } from '../contracts/execution.js';
import { serializeCanonicalJson } from '../core/execution-plan.js';
import { errorMessage } from '../types/guards.js';
import { FakeAgentExecutor } from './fake-executor.js';
import { FileExecutionJournalStore } from './file-journal.js';
import {
  cancelSerialWorkflow,
  pauseSerialWorkflow,
  runSerialWorkflow,
} from './serial-runner.js';

const MAX_JSON_FILE_BYTES = 256 * 1024;
type ExecutionAction = 'cancel' | 'pause' | 'resume' | 'run';

const resolveWorkspaceJson = (workspaceRoot: string, requestedPath: string): string => {
  if (!requestedPath || path.isAbsolute(requestedPath) || path.win32.isAbsolute(requestedPath)) {
    throw new Error('JSON 文件必须使用工作区相对路径');
  }
  const segments = requestedPath.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => !segment || segment === '..')) {
    throw new Error('JSON 文件路径包含非法片段');
  }
  const realWorkspace = realpathSync(workspaceRoot);
  const candidate = realpathSync(path.resolve(realWorkspace, ...segments));
  const relative = path.relative(realWorkspace, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('JSON 文件必须位于当前工作区内');
  }
  const stats = statSync(candidate);
  if (!stats.isFile() || path.extname(candidate).toLowerCase() !== '.json') {
    throw new Error('路径必须指向 .json 文件');
  }
  if (stats.size > MAX_JSON_FILE_BYTES) {
    throw new Error(`JSON 文件超过 ${MAX_JSON_FILE_BYTES} 字节上限`);
  }
  return candidate;
};

const readWorkspaceJson = (workspaceRoot: string, requestedPath: string): unknown =>
  JSON.parse(readFileSync(resolveWorkspaceJson(workspaceRoot, requestedPath), 'utf8')) as unknown;

const resolveExecutionsRoot = (
  workspaceRoot: string,
  workflowProjectRoot: string,
): string => {
  const realWorkspace = realpathSync(workspaceRoot);
  const realProject = realpathSync(workflowProjectRoot);
  const projectRelative = path.relative(realWorkspace, realProject);
  if (
    projectRelative === '..' ||
    projectRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(projectRelative)
  ) {
    throw new Error('.agent-workflow 目录越出当前工作区');
  }
  const runtimeRoot = path.join(realProject, 'runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  if (lstatSync(runtimeRoot).isSymbolicLink()) {
    throw new Error('runtime 目录不得是 symlink');
  }
  const executionsRoot = path.join(realpathSync(runtimeRoot), 'executions');
  mkdirSync(executionsRoot, { recursive: true });
  if (lstatSync(executionsRoot).isSymbolicLink()) {
    throw new Error('executions 目录不得是 symlink');
  }
  return realpathSync(executionsRoot);
};

const printUsage = (): void => {
  process.stdout.write([
    'Usage:',
    '  agent-workflow execution:run --file <workflow.json> --fixture <fake.json> [--input <input.json>] [--run-id <id>] [--format text|json]',
    '  agent-workflow execution:resume --file <workflow.json> --fixture <fake.json> --run-id <id> [--input <input.json>] [--approve <node-id>] [--format text|json]',
    '  agent-workflow execution:pause --run-id <id> [--format text|json]',
    '  agent-workflow execution:cancel --run-id <id> [--format text|json]',
    '',
  ].join('\n'));
};

const renderText = (result: ExecutionRunResult | ExecutionControlResult): string => {
  const lines = [
    `Run: ${result.runId}`,
    `Status: ${result.status}`,
    `Events: ${result.eventCount}`,
  ];
  if ('workflowId' in result) {
    lines.push(`Workflow: ${result.workflowId}`);
    if (result.error) {
      lines.push(`Error: ${result.error.code} - ${result.error.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
};

const outputResult = (
  result: ExecutionRunResult | ExecutionControlResult,
  format: string,
): void => {
  process.stdout.write(format === 'json'
    ? `${serializeCanonicalJson(result)}\n`
    : renderText(result));
};

export const main = async (args = process.argv.slice(2)): Promise<number> => {
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        approve: { type: 'string', multiple: true },
        file: { type: 'string' },
        fixture: { type: 'string' },
        format: { type: 'string', default: 'text' },
        help: { type: 'boolean', short: 'h' },
        input: { type: 'string' },
        'run-id': { type: 'string' },
      },
      strict: true,
    });
    if (parsed.values.help) {
      printUsage();
      return 0;
    }
    const action = parsed.positionals[0] as ExecutionAction | undefined;
    if (!action || !['cancel', 'pause', 'resume', 'run'].includes(action)) {
      throw new Error('缺少或不支持 execution action');
    }
    if (parsed.positionals.length !== 1) {
      throw new Error('execution action 之后不允许位置参数');
    }
    if (parsed.values.format !== 'text' && parsed.values.format !== 'json') {
      throw new Error('--format 仅支持 text 或 json');
    }
    const { workflowProjectRoot, workspaceRoot } = await import('../config/workspace-paths.js');
    const executionsRoot = resolveExecutionsRoot(workspaceRoot, workflowProjectRoot);
    const runId = parsed.values['run-id'] ??
      `run-${randomBytes(16).toString('hex')}`;

    if (action === 'pause' || action === 'cancel') {
      if (!parsed.values['run-id']) {
        throw new Error(`${action} 必须提供 --run-id`);
      }
      const store = new FileExecutionJournalStore(executionsRoot, runId, { create: false });
      const result = action === 'pause'
        ? pauseSerialWorkflow(store)
        : cancelSerialWorkflow(store);
      outputResult(result, parsed.values.format);
      return 0;
    }

    if (!parsed.values.file || !parsed.values.fixture) {
      throw new Error(`${action} 必须提供 --file 和 --fixture`);
    }
    if (action === 'resume' && !parsed.values['run-id']) {
      throw new Error('resume 必须提供 --run-id');
    }
    const definition = readWorkspaceJson(workspaceRoot, parsed.values.file);
    const fixture = readWorkspaceJson(workspaceRoot, parsed.values.fixture);
    const input = parsed.values.input
      ? readWorkspaceJson(workspaceRoot, parsed.values.input)
      : null;
    const executor = new FakeAgentExecutor(fixture);
    const store = new FileExecutionJournalStore(executionsRoot, runId, {
      create: action === 'run',
    });
    const result = await runSerialWorkflow({
      approvedCheckpoints: parsed.values.approve ?? [],
      definition,
      executor,
      input,
      mode: action === 'run' ? 'start' : 'resume',
      store,
    });
    outputResult(result, parsed.values.format);
    return result.status === 'failed' ? 1 : 0;
  } catch (error: unknown) {
    process.stderr.write(`Execution ${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
