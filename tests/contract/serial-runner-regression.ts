import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type {
  AgentExecutionResult,
  AgentExecutorService,
  ExecutionArtifactReference,
  ExecutionEvent,
  ExecutionJournalStore,
  FakeExecutorFixture,
  WorkflowDefinition,
} from '../../src/contracts/execution.js';
import type { PluginJsonValue } from '../../src/contracts/json.js';
import { workflowRoot } from '../../src/config/workspace-paths.js';
import { errorMessage } from '../../src/types/guards.js';
import {
  FakeAgentExecutor,
  validateFakeExecutorFixture,
} from '../../src/execution/fake-executor.js';
import { FileExecutionJournalStore } from '../../src/execution/file-journal.js';
import {
  cancelSerialWorkflow,
  pauseSerialWorkflow,
  runSerialWorkflow,
} from '../../src/execution/serial-runner.js';

const FIXED_NOW = (): Date => new Date('2026-08-25T00:00:00.000Z');
const CLI_PATH = path.join(workflowRoot, 'dist', 'bin', 'agent-workflow.js');

const capabilities: FakeExecutorFixture['capabilities'] = {
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
  maxConcurrency: 1,
};

const workflow: WorkflowDefinition = {
  id: 'serial-runner-regression',
  limits: {
    maxAgents: 2,
    maxAttemptsPerNode: 3,
    maxConcurrency: 1,
    maxDurationMs: 60000,
    maxExternalWrites: 0,
    maxIterations: 1,
  },
  nodes: [
    {
      id: 'first',
      outputSchema: {
        additionalProperties: false,
        properties: { value: { type: 'string' } },
        required: ['value'],
        type: 'object',
      },
      prompt: 'Produce the first value.',
      type: 'agent',
      workspace: { mode: 'shared-readonly' },
    },
    {
      condition: 'all-succeeded',
      dependsOn: ['first'],
      id: 'gate',
      type: 'gate',
    },
    {
      approvalSummary: 'Approve the deterministic continuation.',
      dependsOn: ['gate'],
      id: 'approval',
      type: 'checkpoint',
    },
    {
      dependsOn: ['approval'],
      id: 'second',
      prompt: 'Produce the second value.',
      type: 'agent',
      workspace: { mode: 'shared-readonly' },
    },
    {
      dependsOn: ['second'],
      id: 'result',
      type: 'join',
    },
  ],
  resultNode: 'result',
  schemaVersion: 1,
};

const fixture: FakeExecutorFixture = {
  capabilities,
  executorId: 'fake/regression',
  nodes: [
    {
      attempts: [
        { output: { invalid: true }, status: 'succeeded' },
        {
          output: { value: 'ready' },
          status: 'succeeded',
          usage: { durationMs: 5, inputTokens: 10, outputTokens: 5, toolCalls: 0 },
        },
      ],
      nodeId: 'first',
    },
    {
      attempts: [{ output: { done: true }, status: 'succeeded' }],
      nodeId: 'second',
    },
  ],
  schemaVersion: 1,
};

const createStore = (root: string, suffix: string): FileExecutionJournalStore =>
  new FileExecutionJournalStore(root, `run-${suffix.padEnd(16, '0')}`);

const runCli = (cwd: string, args: string[]) => spawnSync(
  process.execPath,
  [CLI_PATH, ...args],
  {
    cwd,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  },
);

class CrashBeforeCompletionStore implements ExecutionJournalStore {
  readonly runId: string;
  readonly #delegate: ExecutionJournalStore;
  #crashed = false;

  constructor(delegate: ExecutionJournalStore) {
    this.runId = delegate.runId;
    this.#delegate = delegate;
  }

  append(event: ExecutionEvent): void {
    if (!this.#crashed && event.type === 'node.completed') {
      this.#crashed = true;
      throw new Error('simulated process crash');
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

export const main = async (): Promise<number> => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'serial-runner-'));
  try {
    assert.deepEqual(validateFakeExecutorFixture(fixture), []);
    assert.ok(validateFakeExecutorFixture({ ...fixture, unexpected: true }).length > 0);

    const executionsRoot = path.join(temporaryRoot, 'executions');
    const store = createStore(executionsRoot, 'phase1');
    const firstExecutor = new FakeAgentExecutor(fixture);
    const paused = await runSerialWorkflow({
      definition: workflow,
      executor: firstExecutor,
      input: null,
      now: FIXED_NOW,
      store,
    });
    assert.equal(paused.status, 'paused');
    assert.equal(paused.error?.nodeId, 'approval');
    assert.deepEqual(firstExecutor.requests.map(({ nodeId, attempt }) => [nodeId, attempt]), [
      ['first', 1],
      ['first', 2],
    ]);
    assert.equal(store.readEvents().at(-1)?.type, 'run.paused');

    const resumeExecutor = new FakeAgentExecutor(fixture);
    const completed = await runSerialWorkflow({
      approvedCheckpoints: ['approval'],
      definition: workflow,
      executor: resumeExecutor,
      input: null,
      mode: 'resume',
      now: FIXED_NOW,
      store,
    });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(resumeExecutor.requests.map(({ nodeId, attempt }) => [nodeId, attempt]), [
      ['second', 1],
    ]);
    assert.equal(completed.nodes.find(({ id }) => id === 'first')?.attempts, 2);
    assert.deepEqual(completed.result, {
      results: [{ nodeId: 'second', output: { done: true } }],
    });

    const terminalReplayExecutor = new FakeAgentExecutor(fixture);
    const terminalReplay = await runSerialWorkflow({
      definition: workflow,
      executor: terminalReplayExecutor,
      input: null,
      mode: 'resume',
      now: FIXED_NOW,
      store,
    });
    assert.equal(terminalReplay.status, 'completed');
    assert.equal(terminalReplayExecutor.requests.length, 0);
    assert.equal(terminalReplay.eventCount, completed.eventCount);

    await assert.rejects(runSerialWorkflow({
      definition: {
        ...workflow,
        nodes: workflow.nodes.map((node) => node.id === 'first' && node.type === 'agent'
          ? { ...node, prompt: 'Changed definition.' }
          : node),
      },
      executor: new FakeAgentExecutor(fixture),
      input: null,
      mode: 'resume',
      now: FIXED_NOW,
      store,
    }), /身份不匹配/);
    await assert.rejects(runSerialWorkflow({
      definition: workflow,
      executor: new FakeAgentExecutor(fixture),
      input: { changed: true },
      mode: 'resume',
      now: FIXED_NOW,
      store,
    }), /Input hash/);

    assert.ok(completed.resultArtifact);
    const completedResultArtifact = completed.resultArtifact;
    rmSync(path.join(
      executionsRoot,
      store.runId,
      'artifacts',
      completedResultArtifact.id + '.json',
    ));
    await assert.rejects(runSerialWorkflow({
      definition: workflow,
      executor: new FakeAgentExecutor(fixture),
      input: null,
      mode: 'resume',
      now: FIXED_NOW,
      store,
    }), /Artifact 不存在/);

    const cancellationStore = createStore(executionsRoot, 'cancel');
    const cancellationPaused = await runSerialWorkflow({
      definition: workflow,
      executor: new FakeAgentExecutor(fixture),
      input: null,
      now: FIXED_NOW,
      store: cancellationStore,
    });
    const pauseCount = cancellationPaused.eventCount;
    assert.equal(pauseSerialWorkflow(cancellationStore, FIXED_NOW).eventCount, pauseCount);
    const cancelled = cancelSerialWorkflow(cancellationStore, FIXED_NOW);
    assert.equal(cancelled.status, 'cancelled');
    const cancelledReplayExecutor = new FakeAgentExecutor(fixture);
    const cancelledReplay = await runSerialWorkflow({
      definition: workflow,
      executor: cancelledReplayExecutor,
      input: null,
      mode: 'resume',
      now: FIXED_NOW,
      store: cancellationStore,
    });
    assert.equal(cancelledReplay.status, 'cancelled');
    assert.equal(cancelledReplayExecutor.requests.length, 0);

    const failedWorkflow: WorkflowDefinition = {
      ...workflow,
      id: 'serial-failure',
      limits: { ...workflow.limits, maxAgents: 1, maxAttemptsPerNode: 2 },
      nodes: [{ id: 'fail', prompt: 'Fail safely.', type: 'agent' }],
      resultNode: 'fail',
    };
    const failedFixture: FakeExecutorFixture = {
      capabilities,
      executorId: 'fake/failure',
      nodes: [{
        attempts: [
          {
            error: { code: 'tool-failure', message: 'retry once' },
            retryable: true,
            status: 'failed',
          },
          {
            error: { code: 'tool-failure', message: 'stop' },
            retryable: false,
            status: 'failed',
          },
        ],
        nodeId: 'fail',
      }],
      schemaVersion: 1,
    };
    const failedExecutor = new FakeAgentExecutor(failedFixture);
    const failed = await runSerialWorkflow({
      definition: failedWorkflow,
      executor: failedExecutor,
      input: null,
      now: FIXED_NOW,
      store: createStore(executionsRoot, 'failure'),
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'node-failed');
    assert.equal(failedExecutor.requests.length, 2);

    const malformedExecutor: AgentExecutorService = {
      id: 'malformed/result',
      async describe() {
        return capabilities;
      },
      async execute(request) {
        return {
          apiVersion: 1,
          attempt: request.attempt,
          nodeId: request.nodeId,
          runId: request.runId,
          status: 'succeeded',
        } as unknown as AgentExecutionResult;
      },
    };
    const malformedResult = await runSerialWorkflow({
      definition: failedWorkflow,
      executor: malformedExecutor,
      input: null,
      now: FIXED_NOW,
      store: createStore(executionsRoot, 'malformed'),
    });
    assert.equal(malformedResult.status, 'failed');
    assert.match(malformedResult.error?.message ?? '', /Executor Result/);

    const malformedCapabilitiesExecutor: AgentExecutorService = {
      id: 'malformed/capabilities',
      async describe() {
        return { apiVersion: 1 } as unknown as FakeExecutorFixture['capabilities'];
      },
      async execute() {
        throw new Error('must not execute');
      },
    };
    await assert.rejects(runSerialWorkflow({
      definition: failedWorkflow,
      executor: malformedCapabilitiesExecutor,
      input: null,
      now: FIXED_NOW,
      store: createStore(executionsRoot, 'badcaps'),
    }), /Capabilities/);

    const excessiveUsageFixture: FakeExecutorFixture = {
      capabilities,
      executorId: 'fake/excessive-usage',
      nodes: [{
        attempts: [{
          output: { ok: true },
          status: 'succeeded',
          usage: { toolCalls: 51 },
        }],
        nodeId: 'fail',
      }],
      schemaVersion: 1,
    };
    const excessiveUsage = await runSerialWorkflow({
      definition: failedWorkflow,
      executor: new FakeAgentExecutor(excessiveUsageFixture),
      input: null,
      now: FIXED_NOW,
      store: createStore(executionsRoot, 'usage'),
    });
    assert.equal(excessiveUsage.status, 'failed');
    assert.equal(excessiveUsage.error?.code, 'budget-exhausted');

    const crashWorkflow: WorkflowDefinition = {
      ...failedWorkflow,
      id: 'crash-recovery',
      limits: { ...failedWorkflow.limits, maxDurationMs: 1000 },
      nodes: [{ id: 'recover', prompt: 'Recover safely.', type: 'agent' }],
      resultNode: 'recover',
    };
    const crashFixture: FakeExecutorFixture = {
      capabilities,
      executorId: 'fake/crash',
      nodes: [{
        attempts: [
          { output: { attempt: 1 }, status: 'succeeded' },
          { output: { attempt: 2 }, status: 'succeeded' },
        ],
        nodeId: 'recover',
      }],
      schemaVersion: 1,
    };
    const crashStore = createStore(executionsRoot, 'crash');
    await assert.rejects(runSerialWorkflow({
      definition: crashWorkflow,
      executor: new FakeAgentExecutor(crashFixture),
      input: null,
      now: FIXED_NOW,
      store: new CrashBeforeCompletionStore(crashStore),
    }), /simulated process crash/);
    const recoveredExecutor = new FakeAgentExecutor(crashFixture);
    const recovered = await runSerialWorkflow({
      definition: crashWorkflow,
      executor: recoveredExecutor,
      input: null,
      mode: 'resume',
      now: (): Date => new Date('2026-08-26T00:00:00.000Z'),
      store: crashStore,
    });
    assert.equal(recovered.status, 'completed');
    assert.deepEqual(
      recoveredExecutor.requests.map(({ attempt }) => attempt),
      [2],
    );

    await assert.rejects(runSerialWorkflow({
      definition: {
        ...failedWorkflow,
        limits: { ...failedWorkflow.limits, maxExternalWrites: 1 },
      },
      executor: new FakeAgentExecutor(failedFixture),
      input: null,
      now: FIXED_NOW,
      store: createStore(executionsRoot, 'unsafe'),
    }), /maxExternalWrites/);

    const eventDirectory = path.join(
      executionsRoot,
      store.runId,
      'events',
    );
    const firstEventPath = path.join(eventDirectory, readdirSync(eventDirectory).sort()[0] as string);
    const tampered = JSON.parse(readFileSync(firstEventPath, 'utf8')) as Record<string, unknown>;
    tampered.payload = { tampered: true };
    writeFileSync(firstEventPath, JSON.stringify(tampered), 'utf8');
    assert.throws(() => store.readEvents(), /hash 校验失败/);

    const cliWorkspace = path.join(temporaryRoot, 'cli-workspace');
    mkdirSync(path.join(cliWorkspace, '.agent-workflow'), { recursive: true });
    writeFileSync(path.join(cliWorkspace, '.agent-workflow', 'config.json'), '{}\n', 'utf8');
    writeFileSync(path.join(cliWorkspace, 'workflow.json'), JSON.stringify(failedWorkflow), 'utf8');
    writeFileSync(path.join(cliWorkspace, 'fixture.json'), JSON.stringify({
      ...failedFixture,
      nodes: [{
        attempts: [{ output: { ok: true }, status: 'succeeded' }],
        nodeId: 'fail',
      }],
    }), 'utf8');
    const cli = runCli(cliWorkspace, [
      'execution:run',
      '--file',
      'workflow.json',
      '--fixture',
      'fixture.json',
      '--run-id',
      'run-cccccccccccccccc',
      '--format',
      'json',
    ]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal((JSON.parse(cli.stdout) as { status: string }).status, 'completed');

    writeFileSync(path.join(cliWorkspace, 'checkpoint-workflow.json'), JSON.stringify(workflow), 'utf8');
    writeFileSync(path.join(cliWorkspace, 'checkpoint-fixture.json'), JSON.stringify(fixture), 'utf8');
    const cliPaused = runCli(cliWorkspace, [
      'execution:run',
      '--file',
      'checkpoint-workflow.json',
      '--fixture',
      'checkpoint-fixture.json',
      '--run-id',
      'run-dddddddddddddddd',
      '--format',
      'json',
    ]);
    assert.equal(cliPaused.status, 0, cliPaused.stderr);
    assert.equal((JSON.parse(cliPaused.stdout) as { status: string }).status, 'paused');
    const cliResumed = runCli(cliWorkspace, [
      'execution:resume',
      '--file',
      'checkpoint-workflow.json',
      '--fixture',
      'checkpoint-fixture.json',
      '--run-id',
      'run-dddddddddddddddd',
      '--approve',
      'approval',
      '--format',
      'json',
    ]);
    assert.equal(cliResumed.status, 0, cliResumed.stderr);
    assert.equal((JSON.parse(cliResumed.stdout) as { status: string }).status, 'completed');

    process.stdout.write(
      '串行执行内核回归通过：Fake Executor、重试、Checkpoint、恢复、取消、预算、Journal hash 链与 CLI 均稳定。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`串行执行内核回归失败：${errorMessage(error)}\n`);
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
