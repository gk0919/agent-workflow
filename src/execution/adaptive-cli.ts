import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  WORKFLOW_TRANSITION_SCHEMA_VERSION,
  WORKFLOW_EXECUTION_MODES,
  type WorkflowAdaptiveLimits,
  type WorkflowExecutionMode,
} from '../contracts/execution.js';
import { serializeCanonicalJson } from '../core/execution-plan.js';
import { errorMessage } from '../types/guards.js';
import {
  createWorkflowTransitionRequest,
  previewWorkflowTransition,
  runApprovedWorkflowTransition,
} from './adaptive-runtime.js';
import { FakeAgentExecutor } from './fake-executor.js';
import { FileExecutionJournalStore } from './file-journal.js';

const MAX_JSON_FILE_BYTES = 512 * 1024;
type AdaptiveAction = 'preview' | 'run';
type WorkspacePathResolver = (relativePath: unknown, label?: string) => string;

const readJson = (
  requestedPath: string,
  label: string,
  resolveWorkspacePath: WorkspacePathResolver,
): unknown => {
  const resolved = resolveWorkspacePath(requestedPath, label);
  const stats = statSync(resolved);
  if (!stats.isFile() || path.extname(resolved).toLowerCase() !== '.json') {
    throw new Error(`${label} 必须指向工作区内的 .json 文件`);
  }
  if (stats.size > MAX_JSON_FILE_BYTES) {
    throw new Error(`${label} 超过 ${MAX_JSON_FILE_BYTES} 字节上限`);
  }
  return JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
};

const limitsValue = (value: unknown): WorkflowAdaptiveLimits =>
  value as WorkflowAdaptiveLimits;

const renderPreview = (
  preview: ReturnType<typeof previewWorkflowTransition>,
): string => [
  `Transition: ${preview.transitionId}`,
  `Transition Hash: ${preview.transitionHash}`,
  `Parent: ${preview.parent.runId} (${preview.parent.workflowId})`,
  `Checkpoint: ${preview.parent.checkpointNodeId}`,
  `Child: ${preview.child.workflowId}`,
  `Child Preview Hash: ${preview.child.previewHash}`,
  `Depth: ${preview.cumulativeBudget.depth}/${preview.limits.maxDepth}`,
  `Total Agents: ${preview.cumulativeBudget.totalAgents}/${preview.limits.maxTotalAgents}`,
  `Total Executor Calls: ${preview.cumulativeBudget.totalExecutorCalls}/${preview.limits.maxTotalExecutorCalls}`,
  '',
].join('\n');

const printUsage = (): void => {
  process.stdout.write([
    'Usage:',
    '  agent-workflow execution:adaptive:preview --parent-file <workflow.json> --parent-run-id <id> --checkpoint <node-id> --file <child.json> --transition-id <id> --mode <mode> --limits <limits.json> [--format text|json]',
    '  agent-workflow execution:adaptive:run --parent-file <workflow.json> --parent-run-id <id> --checkpoint <node-id> --file <child.json> --transition-id <id> --mode serial|parallel-readonly --limits <limits.json> --child-run-id <id> --fixture <fake.json> --approval <transition-hash> [--input <input.json>] [--format text|json]',
    '',
  ].join('\n'));
};

/** Public CLI for previewing and activating checkpoint-bound child runs. */
export const main = async (args = process.argv.slice(2)): Promise<number> => {
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        approval: { type: 'string' },
        'child-run-id': { type: 'string' },
        checkpoint: { type: 'string' },
        file: { type: 'string' },
        fixture: { type: 'string' },
        format: { type: 'string', default: 'text' },
        help: { type: 'boolean', short: 'h' },
        input: { type: 'string' },
        limits: { type: 'string' },
        mode: { type: 'string', default: 'parallel-readonly' },
        'parent-file': { type: 'string' },
        'parent-run-id': { type: 'string' },
        'transition-id': { type: 'string' },
      },
      strict: true,
    });
    if (parsed.values.help) {
      printUsage();
      return 0;
    }
    const action = parsed.positionals[0] as AdaptiveAction | undefined;
    if (!action || !['preview', 'run'].includes(action) || parsed.positionals.length !== 1) {
      throw new Error('缺少或不支持 adaptive action');
    }
    const required = [
      ['--parent-file', parsed.values['parent-file']],
      ['--parent-run-id', parsed.values['parent-run-id']],
      ['--checkpoint', parsed.values.checkpoint],
      ['--file', parsed.values.file],
      ['--transition-id', parsed.values['transition-id']],
      ['--limits', parsed.values.limits],
    ] as const;
    const missing = required.find(([, value]) => !value)?.[0];
    if (missing) {
      throw new Error(`${action} 必须提供 ${missing}`);
    }
    if (!WORKFLOW_EXECUTION_MODES.includes(parsed.values.mode as WorkflowExecutionMode)) {
      throw new Error('--mode 不受支持');
    }
    if (parsed.values.format !== 'text' && parsed.values.format !== 'json') {
      throw new Error('--format 仅支持 text 或 json');
    }
    const { resolveWorkspaceRelativePath, loadWorkflowPaths } = await import(
      '../config/workflow-config.js'
    );
    const parentDefinition = readJson(
      parsed.values['parent-file'] as string,
      '--parent-file',
      resolveWorkspaceRelativePath,
    );
    const childDefinition = readJson(
      parsed.values.file as string,
      '--file',
      resolveWorkspaceRelativePath,
    );
    const limits = limitsValue(readJson(
      parsed.values.limits as string,
      '--limits',
      resolveWorkspaceRelativePath,
    ));
    const { compileStaticExecutionPlan } = await import('../core/execution-plan.js');
    const parentPlan = compileStaticExecutionPlan(parentDefinition);
    const request = createWorkflowTransitionRequest({
      checkpointNodeId: parsed.values.checkpoint as string,
      runId: parsed.values['parent-run-id'] as string,
      workflowHash: parentPlan.workflowHash,
      workflowId: parentPlan.workflowId,
    }, childDefinition, {
      executionMode: parsed.values.mode as WorkflowExecutionMode,
      limits,
      transitionId: parsed.values['transition-id'] as string,
    });
    const executionsRoot = path.join(loadWorkflowPaths().runtimeRoot, 'executions');
    const parentStore = new FileExecutionJournalStore(
      executionsRoot,
      request.parent.runId,
      { create: false },
    );
    const preview = previewWorkflowTransition(request, { parentDefinition, parentStore });
    if (action === 'preview') {
      process.stdout.write(parsed.values.format === 'json'
        ? `${serializeCanonicalJson(preview)}\n`
        : renderPreview(preview));
      return 0;
    }
    const runRequired = [
      ['--child-run-id', parsed.values['child-run-id']],
      ['--fixture', parsed.values.fixture],
      ['--approval', parsed.values.approval],
    ] as const;
    const missingRun = runRequired.find(([, value]) => !value)?.[0];
    if (missingRun) {
      throw new Error(`run 必须提供 ${missingRun}`);
    }
    if (request.executionMode === 'writable-worktree') {
      throw new Error('adaptive CLI 暂不提供 writable-worktree 宿主；请使用公共 API 注入 Workspace Service');
    }
    if (parsed.values.approval !== preview.transitionHash) {
      throw new Error('--approval 与当前 Transition 预览不一致');
    }
    const fixture = readJson(
      parsed.values.fixture as string,
      '--fixture',
      resolveWorkspaceRelativePath,
    );
    const input = parsed.values.input
      ? readJson(parsed.values.input, '--input', resolveWorkspaceRelativePath)
      : null;
    const childStore = new FileExecutionJournalStore(
      executionsRoot,
      parsed.values['child-run-id'] as string,
    );
    const result = await runApprovedWorkflowTransition({
      approval: {
        childPreviewHash: preview.child.previewHash,
        executionMode: preview.child.executionMode,
        parentWorkflowHash: preview.parent.workflowHash,
        schemaVersion: WORKFLOW_TRANSITION_SCHEMA_VERSION,
        transitionHash: parsed.values.approval as string,
      },
      childStore,
      executor: new FakeAgentExecutor(fixture),
      input,
      parentDefinition,
      parentStore,
      request,
    });
    process.stdout.write(parsed.values.format === 'json'
      ? `${serializeCanonicalJson(result)}\n`
      : [
        `Transition: ${result.preview.transitionId}`,
        `Parent Events: ${result.parentEventCount}`,
        `Child Run: ${result.child.runId}`,
        `Child Status: ${result.child.status}`,
        '',
      ].join('\n'));
    return result.child.status === 'failed' ? 1 : 0;
  } catch (error: unknown) {
    process.stderr.write(`Adaptive execution ${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
