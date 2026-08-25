import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { PluginJsonValue } from '../../src/contracts/json.js';
import type {
  AgentCancellationRequest,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutorCapabilities,
  AgentExecutorService,
  ExecutionArtifactReference,
  ExecutionEvent,
  ExecutionJournalStore,
  FakeExecutorFixture,
  WorkflowDefinition,
} from '../../src/contracts/execution.js';
import { workflowRoot } from '../../src/config/workspace-paths.js';
import { compileStaticExecutionPlan } from '../../src/core/execution-plan.js';
import { FakeAgentExecutor } from '../../src/execution/fake-executor.js';
import { FileExecutionJournalStore } from '../../src/execution/file-journal.js';
import {
  cancelSerialWorkflow,
  runParallelWorkflow,
  runSerialWorkflow,
} from '../../src/execution/serial-runner.js';
import { errorMessage } from '../../src/types/guards.js';

const FIXED_NOW = (): Date => new Date('2026-08-25T00:00:00.000Z');
const CLI_PATH = path.join(workflowRoot, 'dist', 'bin', 'agent-workflow.js');

const capabilities: AgentExecutorCapabilities = {
  apiVersion: 1,
  capabilities: ['structured-output'],
  features: {
    cancellation: true,
    modelRouting: false,
    persistentResume: true,
    structuredOutput: true,
    toolAllowlist: true,
    usageReporting: true,
    workspaceIsolation: false,
  },
  maxConcurrency: 2,
};

const workflow: WorkflowDefinition = {
  id: 'parallel-runner-regression',
  limits: {
    maxAgents: 8,
    maxAttemptsPerNode: 3,
    maxConcurrency: 3,
    maxDurationMs: 60000,
    maxExternalWrites: 0,
    maxIterations: 1,
  },
  nodes: [
    { id: 'source', prompt: 'Return items.', type: 'agent' },
    {
      dependsOn: ['source'],
      failurePolicy: 'isolate',
      id: 'review-map',
      itemsPointer: '/items',
      maxItems: 3,
      prompt: 'Review one item.',
      type: 'map',
    },
    {
      dependsOn: ['source'],
      failurePolicy: 'isolate',
      id: 'branch-bad',
      prompt: 'Return an isolated failure.',
      type: 'agent',
    },
    {
      dependsOn: ['source'],
      id: 'branch-good',
      prompt: 'Return a successful branch.',
      type: 'agent',
    },
    {
      dependsOn: ['branch-bad', 'branch-good'],
      id: 'partial',
      minSuccess: 1,
      mode: 'independent',
      type: 'parallel',
    },
    {
      dependsOn: ['review-map'],
      id: 'dedupe',
      itemsPointer: '/items',
      strategy: 'dedupe',
      type: 'reduce',
    },
    {
      dependsOn: ['dedupe'],
      id: 'verifier-a',
      prompt: 'Verify independently as A.',
      type: 'agent',
    },
    {
      dependsOn: ['dedupe'],
      id: 'verifier-b',
      prompt: 'Verify independently as B.',
      type: 'agent',
    },
    {
      dependsOn: ['verifier-a', 'verifier-b'],
      id: 'adversarial',
      minSuccess: 2,
      mode: 'adversarial',
      type: 'parallel',
    },
    {
      dependsOn: ['adversarial', 'partial'],
      id: 'result',
      type: 'join',
    },
  ],
  resultNode: 'result',
  schemaVersion: 1,
};

const fixture = (reverseDelays = false): FakeExecutorFixture => {
  const delay = (value: number): number => reverseDelays ? 50 - value : value;
  return {
    capabilities,
    executorId: 'fake/parallel',
    nodes: [
      {
        attempts: [{ delayMs: delay(1), output: { items: ['a', 'b', 'a'] }, status: 'succeeded' }],
        nodeId: 'source',
      },
      {
        attempts: [{ delayMs: delay(40), output: { code: 'duplicate' }, status: 'succeeded' }],
        laneId: 'item-000001',
        nodeId: 'review-map',
      },
      {
        attempts: [{
          delayMs: delay(5),
          error: { code: 'tool-failure', message: 'isolated map failure' },
          status: 'failed',
        }],
        laneId: 'item-000002',
        nodeId: 'review-map',
      },
      {
        attempts: [{ delayMs: delay(20), output: { code: 'duplicate' }, status: 'succeeded' }],
        laneId: 'item-000003',
        nodeId: 'review-map',
      },
      {
        attempts: [{
          delayMs: delay(10),
          error: { code: 'tool-failure', message: 'isolated branch failure' },
          status: 'failed',
        }],
        nodeId: 'branch-bad',
      },
      {
        attempts: [{ delayMs: delay(30), output: { branch: 'good' }, status: 'succeeded' }],
        nodeId: 'branch-good',
      },
      {
        attempts: [{ delayMs: delay(15), output: { verdict: 'a' }, status: 'succeeded' }],
        nodeId: 'verifier-a',
      },
      {
        attempts: [{ delayMs: delay(35), output: { verdict: 'b' }, status: 'succeeded' }],
        nodeId: 'verifier-b',
      },
    ],
    schemaVersion: 1,
  };
};

class TrackingExecutor implements AgentExecutorService {
  readonly id: string;
  readonly #delegate: FakeAgentExecutor;
  active = 0;
  maxActive = 0;

  constructor(value: FakeExecutorFixture) {
    this.#delegate = new FakeAgentExecutor(value);
    this.id = this.#delegate.id;
  }

  get requests(): readonly AgentExecutionRequest[] {
    return this.#delegate.requests;
  }

  async cancel(request: AgentCancellationRequest): Promise<void> {
    await this.#delegate.cancel(request);
  }

  async describe(): Promise<AgentExecutorCapabilities> {
    return this.#delegate.describe();
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.#delegate.execute(request);
    } finally {
      this.active -= 1;
    }
  }
}

class CrashBeforeMapCompletionStore implements ExecutionJournalStore {
  readonly runId: string;
  readonly #delegate: ExecutionJournalStore;
  #crashed = false;

  constructor(delegate: ExecutionJournalStore) {
    this.runId = delegate.runId;
    this.#delegate = delegate;
  }

  append(event: ExecutionEvent): void {
    if (
      !this.#crashed &&
      event.type === 'node.completed' &&
      event.nodeId === 'review-map' &&
      !event.laneId
    ) {
      this.#crashed = true;
      throw new Error('simulated map completion crash');
    }
    this.#delegate.append(event);
  }

  readEvents(): readonly ExecutionEvent[] {
    return this.#delegate.readEvents();
  }

  readJsonArtifact(reference: ExecutionArtifactReference): PluginJsonValue {
    return this.#delegate.readJsonArtifact(reference);
  }

  writeJsonArtifact(value: PluginJsonValue): ExecutionArtifactReference {
    return this.#delegate.writeJsonArtifact(value);
  }
}

class CancelBeforeOutputCommitStore implements ExecutionJournalStore {
  readonly runId: string;
  readonly #delegate: ExecutionJournalStore;
  #cancelled = false;

  constructor(delegate: ExecutionJournalStore) {
    this.runId = delegate.runId;
    this.#delegate = delegate;
  }

  append(event: ExecutionEvent): void {
    if (!this.#cancelled && event.type === 'node.output-validated') {
      this.#cancelled = true;
      cancelSerialWorkflow(this.#delegate, FIXED_NOW);
    }
    this.#delegate.append(event);
  }

  readEvents(): readonly ExecutionEvent[] {
    return this.#delegate.readEvents();
  }

  readJsonArtifact(reference: ExecutionArtifactReference): PluginJsonValue {
    return this.#delegate.readJsonArtifact(reference);
  }

  writeJsonArtifact(value: PluginJsonValue): ExecutionArtifactReference {
    return this.#delegate.writeJsonArtifact(value);
  }
}

class BlockingExecutor implements AgentExecutorService {
  readonly id = 'blocking/parallel';
  readonly cancellations: AgentCancellationRequest[] = [];
  readonly requests: AgentExecutionRequest[] = [];
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor() {
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  async cancel(request: AgentCancellationRequest): Promise<void> {
    this.cancellations.push(structuredClone(request));
  }

  async describe(): Promise<AgentExecutorCapabilities> {
    return capabilities;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.requests.push(structuredClone(request));
    if (this.requests.length === 2) {
      this.#resolveReady?.();
    }
    return new Promise<AgentExecutionResult>(() => undefined);
  }

  async waitUntilReady(): Promise<void> {
    await this.#ready;
  }
}

const createStore = (root: string, suffix: string): FileExecutionJournalStore =>
  new FileExecutionJournalStore(root, `run-${suffix.padEnd(16, '0')}`);

const eventProjection = (events: readonly ExecutionEvent[]) => events.map((event) => ({
  attempt: event.attempt,
  laneId: event.laneId,
  nodeId: event.nodeId,
  payload: event.payload,
  type: event.type,
}));

export const main = async (): Promise<number> => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'parallel-runner-'));
  try {
    const plan = compileStaticExecutionPlan(workflow);
    assert.deepEqual(plan.layers[1], ['branch-bad', 'branch-good', 'review-map']);
    assert.throws(() => compileStaticExecutionPlan({
      ...workflow,
      limits: { ...workflow.limits, maxAgents: 7 },
    }), /Agent 节点超过上限/);
    assert.throws(() => compileStaticExecutionPlan({
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === 'adversarial' && node.type === 'parallel'
        ? { ...node, minSuccess: 1 }
        : node),
    }), /adversarial 模式至少需要两个分支成功/);
    await assert.rejects(runSerialWorkflow({
      definition: workflow,
      executor: new FakeAgentExecutor(fixture()),
      input: null,
      now: FIXED_NOW,
      store: createStore(temporaryRoot, 'serialreject'),
    }), /Phase 1 不支持/, 'serial runner must reject Phase 2 nodes');

    const inheritedPointerWorkflow: WorkflowDefinition = {
      id: 'inherited-pointer',
      limits: {
        maxAgents: 2,
        maxAttemptsPerNode: 1,
        maxConcurrency: 1,
        maxDurationMs: 1000,
        maxExternalWrites: 0,
        maxIterations: 1,
      },
      nodes: [
        { id: 'source', prompt: 'Return an object.', type: 'agent' },
        {
          dependsOn: ['source'],
          id: 'result',
          itemsPointer: '/toString',
          maxItems: 1,
          prompt: 'Must not read inherited properties.',
          type: 'map',
        },
      ],
      resultNode: 'result',
      schemaVersion: 1,
    };
    const inheritedPointerResult = await runParallelWorkflow({
      definition: inheritedPointerWorkflow,
      executor: new FakeAgentExecutor({
        capabilities: { ...capabilities, maxConcurrency: 1 },
        executorId: 'fake/inherited-pointer',
        nodes: [{ attempts: [{ output: {}, status: 'succeeded' }], nodeId: 'source' }],
        schemaVersion: 1,
      }),
      input: null,
      now: FIXED_NOW,
      store: createStore(temporaryRoot, 'pointer'),
    });
    assert.equal(inheritedPointerResult.status, 'failed');
    assert.match(inheritedPointerResult.error?.message ?? '', /JSON Pointer 不存在/);

    const overflowWorkflow: WorkflowDefinition = {
      ...inheritedPointerWorkflow,
      id: 'map-overflow',
      nodes: inheritedPointerWorkflow.nodes.map((node) =>
        node.type === 'map'
          ? {
            dependsOn: node.dependsOn,
            id: node.id,
            maxItems: node.maxItems,
            prompt: node.prompt,
            type: 'map' as const,
          }
          : node),
    };
    const overflowResult = await runParallelWorkflow({
      definition: overflowWorkflow,
      executor: new FakeAgentExecutor({
        capabilities: { ...capabilities, maxConcurrency: 1 },
        executorId: 'fake/map-overflow',
        nodes: [{ attempts: [{ output: ['a', 'b'], status: 'succeeded' }], nodeId: 'source' }],
        schemaVersion: 1,
      }),
      input: null,
      now: FIXED_NOW,
      store: createStore(temporaryRoot, 'overflow'),
    });
    assert.equal(overflowResult.status, 'failed');
    assert.match(overflowResult.error?.message ?? '', /超过 maxItems/);

    const firstStore = createStore(temporaryRoot, 'first');
    const firstExecutor = new TrackingExecutor(fixture());
    const first = await runParallelWorkflow({
      definition: workflow,
      executor: firstExecutor,
      input: null,
      now: FIXED_NOW,
      store: firstStore,
    });
    assert.equal(first.status, 'completed');
    assert.equal(firstExecutor.maxActive, 2);
    assert.ok(first.usage);
    const firstUsage = first.usage;
    assert.equal(firstUsage.maxConcurrencyObserved, 2);
    assert.equal(firstUsage.executorCalls, 8);
    assert.equal(firstUsage.failedCalls, 2);
    assert.equal(first.nodes.find(({ id }) => id === 'branch-bad')?.status, 'failed');
    assert.equal(first.nodes.find(({ id }) => id === 'review-map')?.status, 'completed');
    const dedupeArtifact = first.nodes.find(({ id }) => id === 'dedupe')?.artifact;
    assert.ok(dedupeArtifact);
    assert.deepEqual(firstStore.readJsonArtifact(dedupeArtifact), {
      items: [{ code: 'duplicate' }],
      strategy: 'dedupe',
    });

    const secondStore = createStore(temporaryRoot, 'second');
    const second = await runParallelWorkflow({
      definition: workflow,
      executor: new TrackingExecutor(fixture(true)),
      input: null,
      now: FIXED_NOW,
      store: secondStore,
    });
    assert.equal(second.status, 'completed');
    assert.deepEqual(
      eventProjection(secondStore.readEvents()),
      eventProjection(firstStore.readEvents()),
    );

    const crashStore = createStore(temporaryRoot, 'crash');
    await assert.rejects(runParallelWorkflow({
      definition: workflow,
      executor: new TrackingExecutor(fixture()),
      input: null,
      now: FIXED_NOW,
      store: new CrashBeforeMapCompletionStore(crashStore),
    }), /simulated map completion crash/, 'map completion crash must escape');
    const recoveryExecutor = new TrackingExecutor(fixture());
    const recovered = await runParallelWorkflow({
      definition: workflow,
      executor: recoveryExecutor,
      input: null,
      mode: 'resume',
      now: (): Date => new Date('2026-08-26T00:00:00.000Z'),
      store: crashStore,
    });
    assert.equal(recovered.status, 'completed');
    assert.deepEqual(
      recoveryExecutor.requests.map(({ nodeId }) => nodeId).sort(),
      ['verifier-a', 'verifier-b'],
    );

    const timeoutWorkflow: WorkflowDefinition = {
      id: 'parallel-timeout',
      limits: {
        maxAgents: 1,
        maxAttemptsPerNode: 1,
        maxConcurrency: 1,
        maxDurationMs: 1000,
        maxExternalWrites: 0,
        maxIterations: 1,
      },
      nodes: [{ id: 'slow', prompt: 'Time out safely.', type: 'agent' }],
      resultNode: 'slow',
      schemaVersion: 1,
    };
    const timeoutExecutor = new FakeAgentExecutor({
      capabilities: { ...capabilities, maxConcurrency: 1 },
      executorId: 'fake/timeout',
      nodes: [{
        attempts: [{ delayMs: 1100, output: { late: true }, status: 'succeeded' }],
        nodeId: 'slow',
      }],
      schemaVersion: 1,
    });
    const timedOut = await runParallelWorkflow({
      definition: timeoutWorkflow,
      executor: timeoutExecutor,
      input: null,
      store: createStore(temporaryRoot, 'timeout'),
    });
    assert.equal(timedOut.status, 'failed');
    assert.match(timedOut.error?.message ?? '', /超时/);
    assert.equal(timeoutExecutor.cancellations.length, 1);

    const cancellationRaceStore = createStore(temporaryRoot, 'cancelrace');
    const cancellationRace = await runParallelWorkflow({
      definition: timeoutWorkflow,
      executor: new FakeAgentExecutor({
        capabilities: { ...capabilities, maxConcurrency: 1 },
        executorId: 'fake/cancel-race',
        nodes: [{ attempts: [{ output: { ok: true }, status: 'succeeded' }], nodeId: 'slow' }],
        schemaVersion: 1,
      }),
      input: null,
      now: FIXED_NOW,
      store: new CancelBeforeOutputCommitStore(cancellationRaceStore),
    });
    assert.equal(cancellationRace.status, 'cancelled');
    assert.equal(cancellationRaceStore.readEvents().at(-1)?.type, 'run.cancelled');

    const cancellationWorkflow: WorkflowDefinition = {
      id: 'parallel-cancellation',
      limits: {
        maxAgents: 2,
        maxAttemptsPerNode: 2,
        maxConcurrency: 2,
        maxDurationMs: 60000,
        maxExternalWrites: 0,
        maxIterations: 1,
      },
      nodes: [
        { id: 'left', prompt: 'Block left.', type: 'agent' },
        { id: 'right', prompt: 'Block right.', type: 'agent' },
        { dependsOn: ['left', 'right'], id: 'result', type: 'join' },
      ],
      resultNode: 'result',
      schemaVersion: 1,
    };
    const cancellationStore = createStore(temporaryRoot, 'cancel');
    const blockingExecutor = new BlockingExecutor();
    const running = runParallelWorkflow({
      definition: cancellationWorkflow,
      executor: blockingExecutor,
      input: null,
      store: cancellationStore,
    });
    await blockingExecutor.waitUntilReady();
    const controlled = cancelSerialWorkflow(cancellationStore);
    assert.equal(controlled.status, 'cancelled');
    const cancelled = await running;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(blockingExecutor.cancellations.length, 2);
    const terminalReplayExecutor = new FakeAgentExecutor({
      capabilities,
      executorId: 'fake/cancel-replay',
      nodes: [{ attempts: [{ output: null, status: 'succeeded' }], nodeId: 'left' }],
      schemaVersion: 1,
    });
    const cancelledReplay = await runParallelWorkflow({
      definition: cancellationWorkflow,
      executor: terminalReplayExecutor,
      input: null,
      mode: 'resume',
      store: cancellationStore,
    });
    assert.equal(cancelledReplay.status, 'cancelled');
    assert.equal(terminalReplayExecutor.requests.length, 0);

    const cliWorkspace = path.join(temporaryRoot, 'cli-workspace');
    mkdirSync(path.join(cliWorkspace, '.agent-workflow'), { recursive: true });
    writeFileSync(path.join(cliWorkspace, '.agent-workflow', 'config.json'), '{}\n', 'utf8');
    writeFileSync(path.join(cliWorkspace, 'workflow.json'), JSON.stringify(workflow), 'utf8');
    writeFileSync(path.join(cliWorkspace, 'fixture.json'), JSON.stringify(fixture()), 'utf8');
    const cli = spawnSync(process.execPath, [
      CLI_PATH,
      'execution:parallel:run',
      '--file',
      'workflow.json',
      '--fixture',
      'fixture.json',
      '--run-id',
      'run-cccccccccccccccc',
      '--format',
      'json',
    ], {
      cwd: cliWorkspace,
      encoding: 'utf8',
      env: process.env,
      windowsHide: true,
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal((JSON.parse(cli.stdout) as { status: string }).status, 'completed');

    process.stdout.write(
      '并行执行内核回归通过：稳定批次、有界并发、map/parallel/reduce、失败隔离、恢复、取消、统计与 CLI 均稳定。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`并行执行内核回归失败：${errorMessage(error)}\n`);
    return 1;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
