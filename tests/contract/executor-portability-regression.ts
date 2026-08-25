import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type {
  AgentCancellationRequest,
  AgentExecutionRequest,
  AgentExecutorCapabilities,
  ExecutionEvent,
  WorkflowDefinition,
} from '../../src/contracts/execution.js';
import type { PluginJsonValue } from '../../src/contracts/json.js';
import { workflowRoot } from '../../src/config/workspace-paths.js';
import {
  negotiateExecutorCapabilities,
} from '../../src/execution/capability-negotiation.js';
import { FileExecutionJournalStore } from '../../src/execution/file-journal.js';
import {
  NativeHostAgentExecutor,
  type NativeAgentHost,
  type NativeAgentHostResult,
} from '../../src/execution/native-host-executor.js';
import { ProcessAgentExecutor } from '../../src/execution/process-executor.js';
import { runPortableWorkflow } from '../../src/execution/serial-runner.js';
import { errorMessage } from '../../src/types/guards.js';

const FIXED_NOW = (): Date => new Date('2026-08-25T00:00:00.000Z');
const PROCESS_FIXTURE = path.join(
  workflowRoot,
  'dist',
  'tests',
  'fixtures',
  'executors',
  'process-agent-executor.js',
);

const outputFor = (
  request: AgentExecutionRequest,
  invalidOutput = false,
): PluginJsonValue => {
  if (request.nodeId === 'source') {
    return { items: [{ key: 'alpha' }, { key: 'beta' }] };
  }
  if (request.nodeId === 'inspect-items' && request.lane) {
    return { accepted: true, key: request.lane.index === 0 ? 'alpha' : 'beta' };
  }
  if (request.nodeId === 'verify') {
    return invalidOutput
      ? { count: 'two', valid: true }
      : { count: 2, valid: true };
  }
  return null;
};

const nativeCapabilities: AgentExecutorCapabilities = {
  apiVersion: 1,
  capabilities: ['structured-output'],
  features: {
    cancellation: true,
    modelRouting: false,
    persistentResume: false,
    structuredOutput: true,
    toolAllowlist: true,
    usageReporting: true,
    workspaceIsolation: false,
  },
  maxConcurrency: 2,
};

class ConformanceNativeHost implements NativeAgentHost {
  readonly id = 'native/conformance';
  readonly #invalidOutput: boolean;
  readonly cancellations: AgentCancellationRequest[] = [];
  readonly requests: AgentExecutionRequest[] = [];

  constructor(invalidOutput = false) {
    this.#invalidOutput = invalidOutput;
  }

  async cancel(request: AgentCancellationRequest): Promise<void> {
    this.cancellations.push(structuredClone(request));
  }

  async getCapabilities(): Promise<AgentExecutorCapabilities> {
    return structuredClone(nativeCapabilities);
  }

  async invoke(request: AgentExecutionRequest): Promise<NativeAgentHostResult> {
    this.requests.push(structuredClone(request));
    return {
      output: outputFor(request, this.#invalidOutput),
      status: 'succeeded',
      usage: {
        durationMs: 1,
        inputTokens: 2,
        outputTokens: 3,
        toolCalls: 0,
      },
    };
  }
}

const workflow: WorkflowDefinition = {
  id: 'executor-portability-regression',
  limits: {
    maxAgents: 4,
    maxAttemptsPerNode: 1,
    maxConcurrency: 2,
    maxDurationMs: 30000,
    maxExternalWrites: 0,
    maxIterations: 1,
  },
  nodes: [
    {
      id: 'source',
      outputSchema: {
        additionalProperties: false,
        properties: {
          items: {
            items: {
              additionalProperties: false,
              properties: { key: { type: 'string' } },
              required: ['key'],
              type: 'object',
            },
            type: 'array',
          },
        },
        required: ['items'],
        type: 'object',
      },
      prompt: 'Return portable items.',
      requiredCapabilities: ['structured-output'],
      type: 'agent',
    },
    {
      dependsOn: ['source'],
      id: 'inspect-items',
      itemsPointer: '/items',
      maxItems: 2,
      outputSchema: {
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean' },
          key: { type: 'string' },
        },
        required: ['accepted', 'key'],
        type: 'object',
      },
      prompt: 'Inspect one portable item.',
      requiredCapabilities: ['structured-output'],
      type: 'map',
    },
    {
      dependsOn: ['inspect-items'],
      id: 'collect',
      itemsPointer: '/items',
      strategy: 'collect',
      type: 'reduce',
    },
    {
      dependsOn: ['collect'],
      id: 'verify',
      outputSchema: {
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          valid: { const: true },
        },
        required: ['count', 'valid'],
        type: 'object',
      },
      prompt: 'Verify the portable collection.',
      requiredCapabilities: ['structured-output'],
      type: 'agent',
    },
    {
      condition: 'all-succeeded',
      dependsOn: ['verify'],
      id: 'result-gate',
      type: 'gate',
    },
  ],
  resultNode: 'result-gate',
  schemaVersion: 1,
};

const createStore = (root: string, suffix: string): FileExecutionJournalStore =>
  new FileExecutionJournalStore(root, `run-${suffix.padEnd(16, '0')}`);

const semanticEventProjection = (events: readonly ExecutionEvent[]) => events
  .filter(({ type }) => [
    'node.output-validated',
    'node.completed',
    'node.failed',
    'run.completed',
    'run.failed',
  ].includes(type))
  .map(({ attempt, laneId, nodeId, payload, type }) => ({
    attempt,
    laneId,
    nodeId,
    payload,
    type,
  }));

const executorMode = (events: readonly ExecutionEvent[]): unknown =>
  events.find(({ type }) => type === 'run.started')?.payload.executorMode;

export const main = async (): Promise<number> => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'executor-portability-'));
  try {
    const nativeHost = new ConformanceNativeHost();
    const nativeExecutor = new NativeHostAgentExecutor(nativeHost);
    const processExecutor = new ProcessAgentExecutor({
      arguments: [PROCESS_FIXTURE],
      command: process.execPath,
      id: 'process/conformance',
    });

    const processCapabilities = await processExecutor.describe();
    const nativeNegotiation = negotiateExecutorCapabilities(workflow, nativeCapabilities);
    const processNegotiation = negotiateExecutorCapabilities(workflow, processCapabilities);
    assert.equal(nativeNegotiation.mode, 'parallel');
    assert.equal(nativeNegotiation.effectiveConcurrency, 2);
    assert.equal(processNegotiation.mode, 'serial-fallback');
    assert.equal(processNegotiation.effectiveConcurrency, 1);
    assert.deepEqual(processNegotiation.errors, []);
    const incompatibleNegotiation = negotiateExecutorCapabilities(workflow, {
      ...processCapabilities,
      capabilities: [],
      features: { ...processCapabilities.features, structuredOutput: false },
    });
    assert.equal(incompatibleNegotiation.compatible, false);
    assert.match(incompatibleNegotiation.errors.join('\n'), /structured-output/);

    const rejectedFallbackStore = createStore(temporaryRoot, 'rejectfallback');
    await assert.rejects(runPortableWorkflow({
      definition: workflow,
      executor: processExecutor,
      input: null,
      now: FIXED_NOW,
      serialFallback: 'reject',
      store: rejectedFallbackStore,
    }), /只能提供串行能力/);
    assert.deepEqual(rejectedFallbackStore.readEvents(), []);

    const nativeStore = createStore(temporaryRoot, 'native');
    const processStore = createStore(temporaryRoot, 'process');
    const nativeResult = await runPortableWorkflow({
      definition: workflow,
      executor: nativeExecutor,
      input: null,
      now: FIXED_NOW,
      store: nativeStore,
    });
    const processResult = await runPortableWorkflow({
      definition: workflow,
      executor: processExecutor,
      input: null,
      now: FIXED_NOW,
      store: processStore,
    });
    assert.equal(nativeResult.status, 'completed');
    assert.equal(processResult.status, 'completed');
    assert.deepEqual(
      {
        nodes: nativeResult.nodes,
        result: nativeResult.result,
        resultArtifact: nativeResult.resultArtifact,
        status: nativeResult.status,
        workflowHash: nativeResult.workflowHash,
      },
      {
        nodes: processResult.nodes,
        result: processResult.result,
        resultArtifact: processResult.resultArtifact,
        status: processResult.status,
        workflowHash: processResult.workflowHash,
      },
    );
    assert.deepEqual(
      semanticEventProjection(nativeStore.readEvents()),
      semanticEventProjection(processStore.readEvents()),
    );
    assert.equal(executorMode(nativeStore.readEvents()), 'parallel');
    assert.equal(executorMode(processStore.readEvents()), 'serial-fallback');
    assert.equal(nativeHost.requests.length, 4);

    const invalidNativeResult = await runPortableWorkflow({
      definition: workflow,
      executor: new NativeHostAgentExecutor(new ConformanceNativeHost(true)),
      input: null,
      now: FIXED_NOW,
      store: createStore(temporaryRoot, 'invalidnative'),
    });
    const invalidProcessResult = await runPortableWorkflow({
      definition: workflow,
      executor: new ProcessAgentExecutor({
        arguments: [PROCESS_FIXTURE, '--invalid-output'],
        command: process.execPath,
        id: 'process/conformance',
      }),
      input: null,
      now: FIXED_NOW,
      store: createStore(temporaryRoot, 'invalidprocess'),
    });
    assert.equal(invalidNativeResult.status, 'failed');
    assert.equal(invalidProcessResult.status, 'failed');
    assert.equal(invalidNativeResult.error?.code, 'node-failed');
    assert.equal(invalidProcessResult.error?.code, 'node-failed');
    assert.match(invalidNativeResult.error?.message ?? '', /结构化输出无效/);
    assert.equal(invalidNativeResult.error?.message, invalidProcessResult.error?.message);

    await assert.rejects(new ProcessAgentExecutor({
      arguments: [PROCESS_FIXTURE, '--invalid-json'],
      command: process.execPath,
      id: 'process/invalid-json',
    }).describe(), /响应不是有效 JSON/);
    await assert.rejects(new ProcessAgentExecutor({
      arguments: [PROCESS_FIXTURE, '--wrong-request-id'],
      command: process.execPath,
      id: 'process/wrong-request-id',
    }).describe(), /响应身份或协议版本不匹配/);
    await assert.rejects(new ProcessAgentExecutor({
      arguments: [PROCESS_FIXTURE, '--wrong-executor-id'],
      command: process.execPath,
      id: 'process/conformance',
    }).execute({
      apiVersion: 1,
      attempt: 1,
      contextArtifacts: [],
      idempotencyKey: 'identity-check',
      limits: { maxDurationMs: 1000, maxOutputBytes: 1024, maxToolCalls: 0 },
      nodeId: 'source',
      permissions: [],
      preferredCapabilities: [],
      prompt: 'Return portable items.',
      requiredCapabilities: [],
      runId: 'run-identitycheck000',
      workspace: { mode: 'shared-readonly' },
    }), /executor.id 与配置不匹配/);
    assert.throws(() => new ProcessAgentExecutor({
      command: '',
      id: 'process/invalid-command',
    }), /command 不能为空/);

    process.stdout.write(
      '执行内核 Phase 3 回归通过：原生宿主与独立进程 Executor 保持节点、Gate、Schema 和终态语义一致，并验证串行降级与协议拒绝路径。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`执行内核 Phase 3 回归失败：${errorMessage(error)}\n`);
    return 1;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
};

process.exitCode = await main();
