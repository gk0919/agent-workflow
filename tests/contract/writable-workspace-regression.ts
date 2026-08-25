import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { PluginJsonValue } from '../../src/contracts/json.js';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutorCapabilities,
  AgentExecutorService,
  ExecutionArtifactReference,
  ExecutionEvent,
  ExecutionJournalStore,
  WorkflowDefinition,
} from '../../src/contracts/execution.js';
import { workflowRoot } from '../../src/config/workspace-paths.js';
import { validateWorkflowDefinition } from '../../src/core/execution-plan.js';
import { FileExecutionJournalStore } from '../../src/execution/file-journal.js';
import { GitWorktreeWorkspaceService } from '../../src/execution/git-worktree-workspace.js';
import { runWritableWorkflow } from '../../src/execution/serial-runner.js';
import { errorMessage } from '../../src/types/guards.js';
import type { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';

const require = createRequire(import.meta.url);
const Ajv2020Constructor = (require('ajv/dist/2020.js') as {
  default: typeof Ajv2020;
}).default;
const addFormats = (require('ajv-formats') as { default: FormatsPlugin }).default;

const capabilities: AgentExecutorCapabilities = {
  apiVersion: 1,
  capabilities: ['structured-output'],
  features: {
    cancellation: false,
    modelRouting: false,
    persistentResume: true,
    structuredOutput: true,
    toolAllowlist: true,
    usageReporting: true,
    workspaceIsolation: true,
  },
  maxConcurrency: 4,
};

const git = (cwd: string, ...argumentsList: string[]): string => {
  const result = spawnSync('git', argumentsList, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
};

const success = (
  request: AgentExecutionRequest,
  executorId: string,
  output: PluginJsonValue,
): AgentExecutionResult => ({
  apiVersion: 1,
  artifacts: [],
  attempt: request.attempt,
  executor: { id: executorId },
  findings: [],
  ...(request.lane ? { laneId: request.lane.id } : {}),
  nodeId: request.nodeId,
  output,
  retryable: false,
  runId: request.runId,
  status: 'succeeded',
  usage: {
    durationMs: 1,
    inputTokens: null,
    outputTokens: null,
    toolCalls: 1,
  },
});

class WritingExecutor implements AgentExecutorService {
  readonly id: string;
  readonly requests: AgentExecutionRequest[] = [];
  activeWrites = 0;
  externalCalls = 0;
  maxActiveWrites = 0;
  repositoryCalls = 0;
  readonly #sourceItems: readonly string[];

  constructor(id: string, sourceItems: readonly string[] = ['alpha', 'beta']) {
    this.id = id;
    this.#sourceItems = [...sourceItems];
  }

  async describe(): Promise<AgentExecutorCapabilities> {
    return structuredClone(capabilities);
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.requests.push(structuredClone(request));
    if (request.nodeId === 'seed') {
      return success(request, this.id, { ready: true });
    }
    if (request.nodeId === 'source') {
      return success(request, this.id, { items: [...this.#sourceItems] });
    }
    if (request.nodeId === 'verify') {
      return success(request, this.id, { verified: true });
    }
    if (request.nodeId === 'external-write') {
      this.externalCalls += 1;
      return success(request, this.id, { externalCalls: this.externalCalls });
    }
    if (
      request.nodeId === 'write-files' ||
      request.nodeId === 'writer-a' ||
      request.nodeId === 'writer-b' ||
      request.nodeId === 'repository-write'
    ) {
      const rootPath = request.workspace.rootPath;
      assert.ok(rootPath, 'repository-write request 缺少 host-local rootPath');
      assert.ok(request.workspace.bindingId);
      assert.ok(request.workspace.baseCommit);
      this.repositoryCalls += 1;
      this.activeWrites += 1;
      this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const relativePath = request.nodeId === 'write-files'
          ? `outputs/${request.lane?.id}.txt`
          : request.nodeId === 'repository-write'
            ? 'recovered.txt'
            : 'shared.txt';
        const targetPath = path.join(rootPath, ...relativePath.split('/'));
        mkdirSync(path.dirname(targetPath), { recursive: true });
        writeFileSync(
          targetPath,
          `${request.nodeId}:${request.lane?.id ?? 'node'}\n`,
          'utf8',
        );
        return success(request, this.id, { relativePath });
      } finally {
        this.activeWrites -= 1;
      }
    }
    throw new Error(`测试 Executor 不认识节点 ${request.nodeId}`);
  }
}

class CrashJournalStore implements ExecutionJournalStore {
  readonly runId: string;
  readonly #delegate: ExecutionJournalStore;
  readonly #persistBeforeCrash: boolean;
  #armed = true;

  constructor(delegate: ExecutionJournalStore, persistBeforeCrash: boolean) {
    this.#delegate = delegate;
    this.#persistBeforeCrash = persistBeforeCrash;
    this.runId = delegate.runId;
  }

  append(event: ExecutionEvent): void {
    if (this.#armed && event.type === 'node.effect-confirmed') {
      this.#armed = false;
      if (this.#persistBeforeCrash) {
        this.#delegate.append(event);
      }
      throw new Error('simulated-journal-crash');
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

const limits = (maxAgents: number, maxExternalWrites: number) => ({
  maxAgents,
  maxAttemptsPerNode: 2,
  maxConcurrency: Math.min(4, maxAgents),
  maxDurationMs: 60_000,
  maxExternalWrites,
  maxIterations: 1,
});

const parallelWriteWorkflow: WorkflowDefinition = {
  id: 'writable-workspace-regression',
  limits: limits(5, 3),
  nodes: [
    { id: 'seed', prompt: 'Prepare approval.', type: 'agent' },
    {
      approvalSummary: 'Approve repository writes.',
      dependsOn: ['seed'],
      id: 'approval',
      type: 'checkpoint',
    },
    { dependsOn: ['approval'], id: 'source', prompt: 'Return lane inputs.', type: 'agent' },
    {
      dependsOn: ['source'],
      effect: {
        approvalCheckpoint: 'approval',
        kind: 'repository-write',
        ownedPaths: ['outputs/{lane}.txt'],
        resourceLocks: ['outputs/{lane}.txt'],
      },
      id: 'write-files',
      itemsPointer: '/items',
      maxItems: 2,
      permissions: ['artifact:read', 'workspace:read', 'workspace:write'],
      prompt: 'Write one owned file.',
      type: 'map',
      workspace: { mode: 'exclusive-worktree', repository: 'repo' },
    },
    {
      approvalCheckpoint: 'approval',
      dependsOn: ['write-files'],
      id: 'integrate',
      repository: 'repo',
      type: 'integrator',
    },
    { dependsOn: ['integrate'], id: 'verify', prompt: 'Verify result.', type: 'agent' },
  ],
  resultNode: 'verify',
  schemaVersion: 1,
};

const conflictingWorkflow: WorkflowDefinition = {
  id: 'writable-conflict-regression',
  limits: limits(3, 3),
  nodes: [
    { id: 'seed', prompt: 'Prepare approval.', type: 'agent' },
    {
      approvalSummary: 'Approve conflicting writes.',
      dependsOn: ['seed'],
      id: 'approval',
      type: 'checkpoint',
    },
    ...['writer-a', 'writer-b'].map((id) => ({
      dependsOn: ['approval'],
      effect: {
        approvalCheckpoint: 'approval',
        kind: 'repository-write' as const,
        ownedPaths: ['shared.txt'],
        resourceLocks: ['shared-lock'],
      },
      id,
      permissions: ['workspace:read', 'workspace:write'] as const,
      prompt: 'Write the shared path.',
      type: 'agent' as const,
      workspace: { mode: 'exclusive-worktree' as const, repository: 'repo' },
    })),
    {
      approvalCheckpoint: 'approval',
      dependsOn: ['writer-a', 'writer-b'],
      id: 'integrate',
      repository: 'repo',
      type: 'integrator',
    },
  ],
  resultNode: 'integrate',
  schemaVersion: 1,
};

const externalWorkflow: WorkflowDefinition = {
  id: 'external-effect-regression',
  limits: limits(2, 1),
  nodes: [
    { id: 'seed', prompt: 'Prepare approval.', type: 'agent' },
    {
      approvalSummary: 'Approve external write.',
      dependsOn: ['seed'],
      id: 'approval',
      type: 'checkpoint',
    },
    {
      dependsOn: ['approval'],
      effect: { approvalCheckpoint: 'approval', kind: 'external-write' },
      id: 'external-write',
      prompt: 'Perform one external write.',
      type: 'agent',
    },
  ],
  resultNode: 'external-write',
  schemaVersion: 1,
};

const recoverableRepositoryWorkflow: WorkflowDefinition = {
  id: 'repository-effect-recovery',
  limits: limits(2, 2),
  nodes: [
    { id: 'seed', prompt: 'Prepare approval.', type: 'agent' },
    {
      approvalSummary: 'Approve repository write.',
      dependsOn: ['seed'],
      id: 'approval',
      type: 'checkpoint',
    },
    {
      dependsOn: ['approval'],
      effect: {
        approvalCheckpoint: 'approval',
        kind: 'repository-write',
        ownedPaths: ['recovered.txt'],
      },
      id: 'repository-write',
      permissions: ['workspace:read', 'workspace:write'],
      prompt: 'Write a recoverable file.',
      type: 'agent',
      workspace: { mode: 'exclusive-worktree', repository: 'repo' },
    },
    {
      approvalCheckpoint: 'approval',
      dependsOn: ['repository-write'],
      id: 'integrate',
      repository: 'repo',
      type: 'integrator',
    },
  ],
  resultNode: 'integrate',
  schemaVersion: 1,
};

interface Harness {
  executionsRoot: string;
  repositoryRoot: string;
  service: GitWorktreeWorkspaceService;
}

const runId = (suffix: string): string => `run-${suffix.padEnd(16, '0')}`;

const startAndApprove = async (
  harness: Harness,
  definition: WorkflowDefinition,
  executor: WritingExecutor,
  id: string,
) => {
  const store = new FileExecutionJournalStore(harness.executionsRoot, id);
  const started = await runWritableWorkflow({
    definition,
    executor,
    input: null,
    store,
    workspace: harness.service,
  });
  assert.equal(started.status, 'paused');
  assert.equal(store.readEvents().at(-1)?.type, 'run.paused');
  return { store, started };
};

const definitionPolicyContract = async (harness: Harness): Promise<void> => {
  const withoutIntegrator: WorkflowDefinition = {
    ...recoverableRepositoryWorkflow,
    limits: limits(2, 1),
    nodes: recoverableRepositoryWorkflow.nodes.filter(({ type }) => type !== 'integrator'),
    resultNode: 'repository-write',
  };
  assert.ok(validateWorkflowDefinition(withoutIntegrator).some((finding) =>
    finding.includes('必须由且仅由一个直接 Integrator')));

  const invalidTemplate: WorkflowDefinition = {
    ...recoverableRepositoryWorkflow,
    nodes: recoverableRepositoryWorkflow.nodes.map((node) =>
      node.type === 'agent' && node.id === 'repository-write'
        ? {
          ...node,
          effect: {
            ...(node.effect as NonNullable<typeof node.effect>),
            ownedPaths: ['outputs/{lane}.txt'],
          },
        }
        : node),
  };
  assert.ok(validateWorkflowDefinition(invalidTemplate).some((finding) =>
    finding.includes('agent 节点不能使用 {lane}')));

  const store = new FileExecutionJournalStore(
    harness.executionsRoot,
    runId('missingworkspace'),
  );
  await assert.rejects(runWritableWorkflow({
    definition: recoverableRepositoryWorkflow,
    executor: new WritingExecutor('test/missing-workspace'),
    input: null,
    store,
  }), /Execution Workspace Service/);
  assert.equal(store.readEvents().length, 0);
};

const parallelIsolationContract = async (harness: Harness): Promise<void> => {
  const executor = new WritingExecutor('test/parallel-writer');
  const { store } = await startAndApprove(
    harness,
    parallelWriteWorkflow,
    executor,
    runId('parallel'),
  );
  const result = await runWritableWorkflow({
    approvedCheckpoints: ['approval'],
    definition: parallelWriteWorkflow,
    executor,
    input: null,
    mode: 'resume',
    store,
    workspace: harness.service,
  });
  assert.equal(result.status, 'completed');
  const laneRequests = executor.requests.filter(({ nodeId }) => nodeId === 'write-files');
  assert.equal(laneRequests.length, 2);
  assert.equal(new Set(laneRequests.map(({ workspace }) => workspace.rootPath)).size, 2);
  assert.equal(new Set(laneRequests.map(({ workspace }) => workspace.bindingId)).size, 2);
  assert.ok(executor.maxActiveWrites >= 2, '不同资源锁的 lane 应并行执行');

  const events = store.readEvents();
  assert.equal(events.filter(({ type }) => type === 'node.effect-confirmed').length, 3);
  assert.ok(events.some(({ type }) => type === 'node.workspace-bound'));
  for (const request of laneRequests) {
    assert.ok(!JSON.stringify(events).includes(request.workspace.rootPath as string));
  }
  const integrationEvent = events.find((event) =>
    event.type === 'node.completed' && event.nodeId === 'integrate');
  assert.ok(integrationEvent);
  const integrationArtifact = (integrationEvent.payload.artifact ?? null) as unknown as
    ExecutionArtifactReference;
  const integration = store.readJsonArtifact(integrationArtifact) as Record<string, PluginJsonValue>;
  const commit = integration.commit;
  assert.equal(typeof commit, 'string');
  assert.match(
    git(harness.repositoryRoot, 'show', `${commit as string}:outputs/item-000001.txt`),
    /write-files:item-000001/,
  );
  assert.match(
    git(harness.repositoryRoot, 'show', `${commit as string}:outputs/item-000002.txt`),
    /write-files:item-000002/,
  );
  assert.equal(existsSync(path.join(harness.repositoryRoot, 'outputs')), false);
};

const conflictContract = async (harness: Harness): Promise<void> => {
  const executor = new WritingExecutor('test/conflict-writer');
  const { store } = await startAndApprove(
    harness,
    conflictingWorkflow,
    executor,
    runId('conflict'),
  );
  const result = await runWritableWorkflow({
    approvedCheckpoints: ['approval'],
    definition: conflictingWorkflow,
    executor,
    input: null,
    mode: 'resume',
    store,
    workspace: harness.service,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'merge-conflict');
  assert.equal(executor.maxActiveWrites, 1, '相同 resource lock 的写节点不得并行');
  const integratorFailure = store.readEvents().find((event) =>
    event.type === 'node.failed' && event.nodeId === 'integrate');
  assert.deepEqual(integratorFailure?.payload.conflicts, ['shared.txt']);
  assert.equal(existsSync(path.join(harness.repositoryRoot, 'shared.txt')), false);
};

const emptyMapContract = async (harness: Harness): Promise<void> => {
  const executor = new WritingExecutor('test/empty-map', []);
  const { store } = await startAndApprove(
    harness,
    parallelWriteWorkflow,
    executor,
    runId('emptymap'),
  );
  const result = await runWritableWorkflow({
    approvedCheckpoints: ['approval'],
    definition: parallelWriteWorkflow,
    executor,
    input: null,
    mode: 'resume',
    store,
    workspace: harness.service,
  });
  assert.equal(result.status, 'completed');
  assert.equal(executor.repositoryCalls, 0);
  assert.ok(store.readEvents().some((event) =>
    event.type === 'node.completed' && event.nodeId === 'integrate'));
  assert.ok(!store.readEvents().some((event) =>
    event.type === 'node.effect-prepared' && event.nodeId === 'integrate'));
};

const ownershipContract = async (harness: Harness): Promise<void> => {
  const id = runId('ownership');
  const store = new FileExecutionJournalStore(harness.executionsRoot, id);
  const binding = await harness.service.bind({
    nodeId: 'repository-write',
    ownedPaths: ['owned.txt'],
    purpose: 'agent',
    repository: 'repo',
    runId: id,
  });
  writeFileSync(path.join(binding.rootPath, 'outside.txt'), 'not owned\n', 'utf8');
  await assert.rejects(harness.service.finalize({
    binding,
    effectId: `${id}:repository-write:1:effect`,
    outputArtifact: store.writeJsonArtifact({ wrote: 'outside.txt' }),
  }), /越出 ownership/);

  const renameId = runId('ownershiprename');
  const renameStore = new FileExecutionJournalStore(harness.executionsRoot, renameId);
  const renameBinding = await harness.service.bind({
    nodeId: 'repository-write',
    ownedPaths: ['owned.txt'],
    purpose: 'agent',
    repository: 'repo',
    runId: renameId,
  });
  renameSync(
    path.join(renameBinding.rootPath, 'README.md'),
    path.join(renameBinding.rootPath, 'owned.txt'),
  );
  await assert.rejects(harness.service.finalize({
    binding: renameBinding,
    effectId: `${renameId}:repository-write:1:effect`,
    outputArtifact: renameStore.writeJsonArtifact({ wrote: 'owned.txt' }),
  }), /README\.md/);
};

const verificationFailureContract = async (
  harness: Harness,
  service: GitWorktreeWorkspaceService,
): Promise<void> => {
  const executor = new WritingExecutor('test/verification-failure');
  const failingHarness = { ...harness, service };
  const { store } = await startAndApprove(
    failingHarness,
    recoverableRepositoryWorkflow,
    executor,
    runId('verifyfailure'),
  );
  const result = await runWritableWorkflow({
    approvedCheckpoints: ['approval'],
    definition: recoverableRepositoryWorkflow,
    executor,
    input: null,
    mode: 'resume',
    store,
    workspace: service,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'verification-failed');
  assert.ok(store.readEvents().some((event) =>
    event.type === 'node.failed' &&
    event.nodeId === 'integrate' &&
    event.payload.code === 'verification-failed'));
};

const repositoryRecoveryContract = async (harness: Harness): Promise<void> => {
  const executor = new WritingExecutor('test/recovery-writer');
  const id = runId('reporecovery');
  const { store } = await startAndApprove(
    harness,
    recoverableRepositoryWorkflow,
    executor,
    id,
  );
  await assert.rejects(runWritableWorkflow({
    approvedCheckpoints: ['approval'],
    definition: recoverableRepositoryWorkflow,
    executor,
    input: null,
    mode: 'resume',
    store: new CrashJournalStore(store, false),
    workspace: harness.service,
  }), /simulated-journal-crash/);
  assert.equal(executor.repositoryCalls, 1);
  const recovered = await runWritableWorkflow({
    approvedCheckpoints: ['approval'],
    definition: recoverableRepositoryWorkflow,
    executor,
    input: null,
    mode: 'resume',
    store,
    workspace: harness.service,
  });
  assert.equal(recovered.status, 'completed');
  assert.equal(executor.repositoryCalls, 1, '恢复不得重复执行 repository-write Agent');
  assert.ok(store.readEvents().some((event) =>
    event.type === 'node.effect-confirmed' && event.payload.recovered === true));
};

const externalRecoveryContract = async (
  harness: Harness,
  persistBeforeCrash: boolean,
  suffix: string,
): Promise<void> => {
  const executor = new WritingExecutor(`test/external-${suffix}`);
  const id = runId(suffix);
  const { store } = await startAndApprove(harness, externalWorkflow, executor, id);
  await assert.rejects(runWritableWorkflow({
    approvedCheckpoints: ['approval'],
    definition: externalWorkflow,
    executor,
    input: null,
    mode: 'resume',
    store: new CrashJournalStore(store, persistBeforeCrash),
  }), /simulated-journal-crash/);
  assert.equal(executor.externalCalls, 1);
  const recovered = await runWritableWorkflow({
    approvedCheckpoints: ['approval'],
    definition: externalWorkflow,
    executor,
    input: null,
    mode: 'resume',
    store,
  });
  assert.equal(recovered.status, persistBeforeCrash ? 'completed' : 'paused');
  assert.equal(executor.externalCalls, 1, '恢复不得重复外部副作用');
  if (!persistBeforeCrash) {
    assert.equal(recovered.error?.code, 'effect-recovery-required');
    assert.equal(store.readEvents().at(-1)?.payload.reason, 'effect-recovery-required');
  }
};

export const main = async (): Promise<number> => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-phase4-'));
  try {
    const repositoryRoot = path.join(temporaryRoot, 'repo');
    const executionsRoot = path.join(temporaryRoot, 'runtime', 'executions');
    mkdirSync(repositoryRoot, { recursive: true });
    mkdirSync(executionsRoot, { recursive: true });
    git(repositoryRoot, 'init', '--quiet');
    writeFileSync(path.join(repositoryRoot, 'README.md'), '# fixture\n', 'utf8');
    git(repositoryRoot, 'add', 'README.md');
    git(
      repositoryRoot,
      '-c', 'user.name=fixture',
      '-c', 'user.email=fixture@localhost',
      'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture base',
    );

    let verificationCalls = 0;
    const service = new GitWorktreeWorkspaceService({
      stateRoot: path.join(temporaryRoot, 'runtime', 'execution-workspaces'),
      verify: async ({ changedPaths, rootPath }) => {
        verificationCalls += 1;
        if (!changedPaths.some((changedPath) => changedPath.startsWith('outputs/'))) {
          return [];
        }
        const expected = ['item-000001', 'item-000002']
          .map((laneId) => path.join(rootPath, 'outputs', `${laneId}.txt`));
        if (expected.every(existsSync)) {
          return [];
        }
        return [{
          code: 'missing-integrated-output',
          message: '合并后缺少预期输出',
          severity: 'error',
        }];
      },
      workspaceRoot: temporaryRoot,
      worktreeRoot: path.join(temporaryRoot, 'runtime', 'worktrees'),
    });
    const harness = { executionsRoot, repositoryRoot, service };

    await definitionPolicyContract(harness);
    await parallelIsolationContract(harness);
    assert.equal(verificationCalls, 1);
    await emptyMapContract(harness);
    assert.equal(verificationCalls, 1);
    await ownershipContract(harness);
    // Conflict is rejected before post-merge verification.
    await conflictContract(harness);
    assert.equal(verificationCalls, 1);
    await repositoryRecoveryContract(harness);
    const failingVerificationService = new GitWorktreeWorkspaceService({
      stateRoot: path.join(temporaryRoot, 'runtime', 'execution-workspaces'),
      verify: async () => [{
        code: 'fixture-verification-failed',
        message: 'fixture post-merge verification failed',
        severity: 'error',
      }],
      workspaceRoot: temporaryRoot,
      worktreeRoot: path.join(temporaryRoot, 'runtime', 'worktrees'),
    });
    await verificationFailureContract(harness, failingVerificationService);
    await externalRecoveryContract(harness, false, 'externalpending');
    await externalRecoveryContract(harness, true, 'externalconfirmed');

    const statePath = path.join(
      temporaryRoot,
      'runtime',
      'execution-workspaces',
      `${runId('parallel')}.json`,
    );
    const state: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
    const schema = JSON.parse(readFileSync(path.join(
      workflowRoot,
      'resources',
      'schemas',
      'execution-workspace-state.schema.json',
    ), 'utf8')) as Record<string, unknown>;
    const ajv = new Ajv2020Constructor({ strict: true });
    addFormats(ajv);
    const validateState = ajv.compile(schema);
    assert.equal(validateState(state), true, JSON.stringify(validateState.errors));
    assert.equal((state as { schemaVersion: number }).schemaVersion, 1);
    process.stdout.write(
      '执行内核 Phase 4 回归通过：隔离 Worktree、ownership/锁、Integrator、冲突、验证与副作用恢复语义稳定。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`执行内核 Phase 4 回归失败：${errorMessage(error)}\n`);
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
