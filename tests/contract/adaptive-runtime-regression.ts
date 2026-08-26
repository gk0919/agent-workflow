import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  WORKFLOW_AUTHORING_SCHEMA_VERSION,
  EXECUTION_EVENT_SCHEMA_VERSION,
  WORKFLOW_TRANSITION_SCHEMA_VERSION,
  type FakeExecutorFixture,
  type ExecutionEvent,
  type ExecutionJournalStore,
  type WorkflowAdaptiveLimits,
  type WorkflowDefinition,
  type WorkflowExecutionApproval,
  type WorkflowTransitionApproval,
} from '../../src/contracts/execution.js';
import { loadWorkflowPaths } from '../../src/config/workflow-config.js';
import { workflowRoot, workspaceRoot } from '../../src/config/workspace-paths.js';
import {
  validateExecutionEvent,
  validateWorkflowTransitionRequest,
} from '../../src/core/execution-plan.js';
import {
  createWorkflowTransitionRequest,
  previewWorkflowTransition,
  runApprovedWorkflowTransition,
  validateWorkflowTransitionApproval,
} from '../../src/execution/adaptive-runtime.js';
import { FakeAgentExecutor } from '../../src/execution/fake-executor.js';
import {
  calculateExecutionEventHash,
  FileExecutionJournalStore,
} from '../../src/execution/file-journal.js';
import { runSerialWorkflow } from '../../src/execution/serial-runner.js';
import {
  previewWorkflowDefinition,
  runApprovedWorkflow,
} from '../../src/execution/workflow-authoring.js';
import { errorMessage } from '../../src/types/guards.js';

const FIXED_NOW = (): Date => new Date('2026-08-26T00:00:00.000Z');
const CLI_PATH = path.join(workflowRoot, 'dist', 'bin', 'agent-workflow.js');

const relativeWorkspacePath = (filePath: string): string => path
  .relative(workspaceRoot, filePath)
  .split(path.sep)
  .join('/');

const runCli = (args: string[]) => spawnSync(process.execPath, [CLI_PATH, ...args], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  env: process.env,
  timeout: 30_000,
  windowsHide: true,
});

const limits = (maxAgents: number): WorkflowDefinition['limits'] => ({
  maxAgents,
  maxAttemptsPerNode: 2,
  maxConcurrency: 1,
  maxDurationMs: 60_000,
  maxExternalWrites: 0,
  maxIterations: 1,
});

const segment = (
  id: string,
  agentId: string,
  checkpointId: string,
  tailId: string,
): WorkflowDefinition => ({
  id,
  limits: limits(2),
  nodes: [
    { id: agentId, prompt: `Run ${agentId}.`, type: 'agent' },
    {
      approvalSummary: `Approve transition at ${checkpointId}.`,
      dependsOn: [agentId],
      id: checkpointId,
      type: 'checkpoint',
    },
    {
      dependsOn: [checkpointId],
      id: tailId,
      prompt: `Run ${tailId}.`,
      type: 'agent',
    },
  ],
  resultNode: tailId,
  schemaVersion: 1,
});

const rootDefinition = segment(
  'adaptive-root',
  'root-agent',
  'root-checkpoint',
  'root-tail',
);
const childDefinition = segment(
  'adaptive-child',
  'child-agent',
  'child-checkpoint',
  'child-tail',
);
const grandchildDefinition: WorkflowDefinition = {
  id: 'adaptive-grandchild',
  limits: limits(1),
  nodes: [{ id: 'grandchild-agent', prompt: 'Finish the adaptive chain.', type: 'agent' }],
  resultNode: 'grandchild-agent',
  schemaVersion: 1,
};

const fixture: FakeExecutorFixture = {
  capabilities: {
    apiVersion: 1,
    capabilities: [],
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
  },
  executorId: 'fake/adaptive-runtime',
  nodes: [
    { attempts: [{ output: { value: 'root' }, status: 'succeeded' }], nodeId: 'root-agent' },
    { attempts: [{ output: { value: 'root-tail' }, status: 'succeeded' }], nodeId: 'root-tail' },
    { attempts: [{ output: { value: 'child' }, status: 'succeeded' }], nodeId: 'child-agent' },
    { attempts: [{ output: { value: 'child-tail' }, status: 'succeeded' }], nodeId: 'child-tail' },
    {
      attempts: [{ output: { value: 'grandchild' }, status: 'succeeded' }],
      nodeId: 'grandchild-agent',
    },
  ],
  schemaVersion: 1,
};

const approvalFor = (definition: WorkflowDefinition): WorkflowExecutionApproval => {
  const preview = previewWorkflowDefinition(definition, 'serial');
  return {
    executionMode: 'serial',
    previewHash: preview.previewHash,
    schemaVersion: WORKFLOW_AUTHORING_SCHEMA_VERSION,
    workflowHash: preview.workflowHash,
  };
};

const transitionApprovalFor = (
  preview: ReturnType<typeof previewWorkflowTransition>,
): WorkflowTransitionApproval => ({
  childPreviewHash: preview.child.previewHash,
  executionMode: preview.child.executionMode,
  parentWorkflowHash: preview.parent.workflowHash,
  schemaVersion: WORKFLOW_TRANSITION_SCHEMA_VERSION,
  transitionHash: preview.transitionHash,
});

const adaptiveLimits: WorkflowAdaptiveLimits = {
  maxDepth: 2,
  maxTotalAgents: 5,
  maxTotalDurationMs: 180_000,
  maxTotalExecutorCalls: 10,
  maxTotalExternalWrites: 0,
};

/** Guards checkpoint transitions, cumulative budgets, lineage audit and replay. */
export const main = async (): Promise<number> => {
  const temporaryRoot = mkdtempSync(
    path.join(loadWorkflowPaths().runtimeRoot, 'adaptive-runtime-'),
  );
  const cliParentRunId = `run-${randomBytes(12).toString('hex')}`;
  const cliChildRunId = `run-${randomBytes(12).toString('hex')}`;
  const executionsRoot = path.join(loadWorkflowPaths().runtimeRoot, 'executions');
  try {
    const eventBase = {
      eventId: 'event-adaptiveschemaversion01',
      payload: {},
      runId: 'run-adaptiveschema01',
      sequence: 0,
      timestamp: '2026-08-26T00:00:00.000Z',
      workflowHash: 'a'.repeat(64),
      workflowId: 'adaptive-schema',
    };
    assert.deepEqual(validateExecutionEvent({
      ...eventBase,
      schemaVersion: 1,
      type: 'run.created',
    }), []);
    assert.ok(validateExecutionEvent({
      ...eventBase,
      schemaVersion: 1,
      type: 'run.plan-approved',
    }).length > 0);
    assert.deepEqual(validateExecutionEvent({
      ...eventBase,
      schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
      type: 'run.plan-approved',
    }), []);

    const legacyBackingStore = new FileExecutionJournalStore(
      temporaryRoot,
      'run-adaptivelegacy01',
    );
    const legacyPaused = await runSerialWorkflow({
      definition: rootDefinition,
      executor: new FakeAgentExecutor(fixture),
      input: { request: 'legacy' },
      now: FIXED_NOW,
      store: legacyBackingStore,
    });
    assert.equal(legacyPaused.status, 'paused');
    let previousEventHash: string | null = null;
    const legacyEvents = legacyBackingStore.readEvents().map((event, sequence) => {
      const { eventHash: _eventHash, ...withoutHash } = event;
      const draft: ExecutionEvent = {
        ...withoutHash,
        previousEventHash,
        schemaVersion: 1,
        sequence,
      };
      const converted: ExecutionEvent = {
        ...draft,
        eventHash: calculateExecutionEventHash(draft),
      };
      previousEventHash = converted.eventHash as string;
      return converted;
    });
    const legacyStore: ExecutionJournalStore = {
      append: (event) => {
        assert.deepEqual(validateExecutionEvent(event), []);
        assert.equal(event.previousEventHash, legacyEvents.at(-1)?.eventHash ?? null);
        legacyEvents.push(event);
      },
      readEvents: () => legacyEvents,
      readJsonArtifact: (reference) => legacyBackingStore.readJsonArtifact(reference),
      runId: legacyBackingStore.runId,
      writeJsonArtifact: (value) => legacyBackingStore.writeJsonArtifact(value),
    };
    const resumedLegacy = await runApprovedWorkflow({
      approvedCheckpoints: ['root-checkpoint'],
      approval: approvalFor(rootDefinition),
      definition: rootDefinition,
      executionMode: 'serial',
      executor: new FakeAgentExecutor(fixture),
      input: { request: 'legacy' },
      mode: 'resume',
      now: FIXED_NOW,
      store: legacyStore,
    });
    assert.equal(resumedLegacy.status, 'completed');
    assert.equal(legacyEvents.filter(({ type }) => type === 'run.plan-approved').length, 1);
    assert.equal(legacyEvents.find(({ type }) => type === 'run.plan-approved')?.schemaVersion, 2);

    const parentStore = new FileExecutionJournalStore(
      temporaryRoot,
      'run-adaptiveparent01',
    );
    const parent = await runApprovedWorkflow({
      approval: approvalFor(rootDefinition),
      definition: rootDefinition,
      executionMode: 'serial',
      executor: new FakeAgentExecutor(fixture),
      input: { request: 'root' },
      now: FIXED_NOW,
      store: parentStore,
    });
    assert.equal(parent.status, 'paused');
    assert.equal(parentStore.readEvents().filter(({ type }) =>
      type === 'run.plan-approved').length, 1);

    const parentPreview = previewWorkflowDefinition(rootDefinition, 'serial');
    const request = createWorkflowTransitionRequest({
      checkpointNodeId: 'root-checkpoint',
      runId: parentStore.runId,
      workflowHash: parentPreview.workflowHash,
      workflowId: parentPreview.workflowId,
    }, childDefinition, {
      executionMode: 'serial',
      limits: adaptiveLimits,
      transitionId: 'root-to-child',
    });
    assert.deepEqual(validateWorkflowTransitionRequest(request), []);
    const transitionPreview = previewWorkflowTransition(request, {
      parentDefinition: rootDefinition,
      parentStore,
    });
    assert.equal(transitionPreview.cumulativeBudget.depth, 1);
    assert.equal(transitionPreview.cumulativeBudget.definitions, 2);
    assert.equal(transitionPreview.cumulativeBudget.totalAgents, 4);
    const lowBudgetRequest = createWorkflowTransitionRequest(request.parent, childDefinition, {
      executionMode: 'serial',
      limits: { ...adaptiveLimits, maxTotalAgents: 3 },
      transitionId: 'root-to-child-low-budget',
    });
    assert.throws(() => previewWorkflowTransition(lowBudgetRequest, {
      parentDefinition: rootDefinition,
      parentStore,
    }), /累计预算超限/);
    const transitionApproval = transitionApprovalFor(transitionPreview);
    assert.deepEqual(
      validateWorkflowTransitionApproval(transitionPreview, transitionApproval),
      [],
    );
    assert.match(validateWorkflowTransitionApproval(transitionPreview, {
      ...transitionApproval,
      extra: true,
    }).join('\n'), /未知字段/);

    const parentEventsBeforeRejection = parentStore.readEvents().length;
    const rejectedChildStore = new FileExecutionJournalStore(
      temporaryRoot,
      'run-adaptivereject01',
    );
    await assert.rejects(runApprovedWorkflowTransition({
      approval: { ...transitionApproval, transitionHash: '0'.repeat(64) },
      childStore: rejectedChildStore,
      executor: new FakeAgentExecutor(fixture),
      input: { request: 'child' },
      now: FIXED_NOW,
      parentDefinition: rootDefinition,
      parentStore,
      request,
    }), /transitionHash 不一致/);
    assert.equal(parentStore.readEvents().length, parentEventsBeforeRejection);
    assert.deepEqual(rejectedChildStore.readEvents(), []);

    const collisionStore = new FileExecutionJournalStore(
      temporaryRoot,
      'run-adaptivecollision',
    );
    await runApprovedWorkflow({
      approval: approvalFor(grandchildDefinition),
      definition: grandchildDefinition,
      executionMode: 'serial',
      executor: new FakeAgentExecutor(fixture),
      input: null,
      now: FIXED_NOW,
      store: collisionStore,
    });
    await assert.rejects(runApprovedWorkflowTransition({
      approval: transitionApproval,
      childStore: collisionStore,
      executor: new FakeAgentExecutor(fixture),
      input: { request: 'child' },
      now: FIXED_NOW,
      parentDefinition: rootDefinition,
      parentStore,
      request,
    }), /Child Run ID 已被其他 Workflow 使用/);
    assert.equal(parentStore.readEvents().length, parentEventsBeforeRejection);

    const childStore = new FileExecutionJournalStore(
      temporaryRoot,
      'run-adaptivechild001',
    );
    const transitioned = await runApprovedWorkflowTransition({
      approval: transitionApproval,
      childStore,
      executor: new FakeAgentExecutor(fixture),
      input: { request: 'child' },
      now: FIXED_NOW,
      parentDefinition: rootDefinition,
      parentStore,
      request,
    });
    assert.equal(transitioned.child.status, 'paused');
    const parentTerminal = parentStore.readEvents().at(-1);
    assert.equal(parentTerminal?.type, 'run.transitioned');
    assert.equal(parentTerminal?.payload.outcome, 'transitioned');
    const childApprovalEvent = childStore.readEvents().find(({ type }) =>
      type === 'run.plan-approved');
    assert.equal(childApprovalEvent?.payload.transition !== undefined, true);
    const transitionedParent = await runApprovedWorkflow({
      approval: approvalFor(rootDefinition),
      definition: rootDefinition,
      executionMode: 'serial',
      executor: new FakeAgentExecutor(fixture),
      input: { request: 'root' },
      mode: 'resume',
      now: FIXED_NOW,
      store: parentStore,
    });
    assert.equal(transitionedParent.status, 'transitioned');
    assert.equal(
      (transitionedParent.result as { kind?: string } | undefined)?.kind,
      'workflow-transition-activation',
    );

    const childEventsBeforeRepeat = childStore.readEvents().length;
    const repeated = await runApprovedWorkflowTransition({
      approval: transitionApproval,
      childStore,
      executor: new FakeAgentExecutor(fixture),
      input: { request: 'child' },
      now: FIXED_NOW,
      parentDefinition: rootDefinition,
      parentStore,
      request,
    });
    assert.equal(repeated.child.status, 'paused');
    assert.equal(childStore.readEvents().length, childEventsBeforeRepeat);
    assert.equal(parentStore.readEvents().filter(({ type }) =>
      type === 'run.transitioned').length, 1);
    await assert.rejects(runApprovedWorkflowTransition({
      approval: transitionApproval,
      childStore,
      executor: new FakeAgentExecutor(fixture),
      input: { request: 'changed-child-input' },
      now: FIXED_NOW,
      parentDefinition: rootDefinition,
      parentStore,
      request,
    }), /input 与当前 Transition 调用不匹配/);
    assert.equal(childStore.readEvents().length, childEventsBeforeRepeat);

    const childPreview = previewWorkflowDefinition(childDefinition, 'serial');
    const secondRequest = createWorkflowTransitionRequest({
      checkpointNodeId: 'child-checkpoint',
      runId: childStore.runId,
      workflowHash: childPreview.workflowHash,
      workflowId: childPreview.workflowId,
    }, grandchildDefinition, {
      executionMode: 'serial',
      limits: adaptiveLimits,
      transitionId: 'child-to-grandchild',
    });
    const secondPreview = previewWorkflowTransition(secondRequest, {
      parentDefinition: childDefinition,
      parentStore: childStore,
    });
    assert.equal(secondPreview.cumulativeBudget.depth, 2);
    assert.equal(secondPreview.cumulativeBudget.definitions, 3);
    assert.equal(secondPreview.cumulativeBudget.totalAgents, 5);

    const expandedLimitsRequest = createWorkflowTransitionRequest({
      checkpointNodeId: 'child-checkpoint',
      runId: childStore.runId,
      workflowHash: childPreview.workflowHash,
      workflowId: childPreview.workflowId,
    }, grandchildDefinition, {
      executionMode: 'serial',
      limits: { ...adaptiveLimits, maxDepth: 3 },
      transitionId: 'expanded-budget',
    });
    assert.throws(() => previewWorkflowTransition(expandedLimitsRequest, {
      parentDefinition: childDefinition,
      parentStore: childStore,
    }), /不允许扩大或替换/);

    const grandchildStore = new FileExecutionJournalStore(
      temporaryRoot,
      'run-adaptivegrand001',
    );
    const secondResult = await runApprovedWorkflowTransition({
      approval: transitionApprovalFor(secondPreview),
      childStore: grandchildStore,
      executor: new FakeAgentExecutor(fixture),
      input: { request: 'grandchild' },
      now: FIXED_NOW,
      parentDefinition: childDefinition,
      parentStore: childStore,
      request: secondRequest,
    });
    assert.equal(secondResult.child.status, 'completed');
    assert.equal(childStore.readEvents().at(-1)?.payload.outcome, 'transitioned');
    const grandchildApproval = grandchildStore.readEvents().find(({ type }) =>
      type === 'run.plan-approved');
    const grandchildTransition = grandchildApproval?.payload.transition as
      | Record<string, unknown>
      | undefined;
    assert.equal(grandchildTransition?.depth, 2);

    const parentFile = path.join(temporaryRoot, 'parent.json');
    const childFile = path.join(temporaryRoot, 'child.json');
    const fixtureFile = path.join(temporaryRoot, 'fixture.json');
    const limitsFile = path.join(temporaryRoot, 'limits.json');
    writeFileSync(parentFile, `${JSON.stringify(rootDefinition)}\n`, 'utf8');
    writeFileSync(childFile, `${JSON.stringify(childDefinition)}\n`, 'utf8');
    writeFileSync(fixtureFile, `${JSON.stringify(fixture)}\n`, 'utf8');
    writeFileSync(limitsFile, `${JSON.stringify(adaptiveLimits)}\n`, 'utf8');
    const cliParentStore = new FileExecutionJournalStore(executionsRoot, cliParentRunId);
    const cliParent = await runApprovedWorkflow({
      approval: approvalFor(rootDefinition),
      definition: rootDefinition,
      executionMode: 'serial',
      executor: new FakeAgentExecutor(fixture),
      input: null,
      now: FIXED_NOW,
      store: cliParentStore,
    });
    assert.equal(cliParent.status, 'paused');
    const cliPreview = runCli([
      'execution:adaptive:preview',
      '--parent-file', relativeWorkspacePath(parentFile),
      '--parent-run-id', cliParentRunId,
      '--checkpoint', 'root-checkpoint',
      '--file', relativeWorkspacePath(childFile),
      '--transition-id', 'cli-root-to-child',
      '--mode', 'serial',
      '--limits', relativeWorkspacePath(limitsFile),
      '--format', 'json',
    ]);
    assert.equal(cliPreview.status, 0, cliPreview.stderr);
    const cliTransitionHash = (JSON.parse(cliPreview.stdout) as { transitionHash: string })
      .transitionHash;
    const cliRun = runCli([
      'execution:adaptive:run',
      '--parent-file', relativeWorkspacePath(parentFile),
      '--parent-run-id', cliParentRunId,
      '--checkpoint', 'root-checkpoint',
      '--file', relativeWorkspacePath(childFile),
      '--transition-id', 'cli-root-to-child',
      '--mode', 'serial',
      '--limits', relativeWorkspacePath(limitsFile),
      '--child-run-id', cliChildRunId,
      '--fixture', relativeWorkspacePath(fixtureFile),
      '--approval', cliTransitionHash,
      '--format', 'json',
    ]);
    assert.equal(cliRun.status, 0, cliRun.stderr);
    assert.equal(
      (JSON.parse(cliRun.stdout) as { child: { status: string } }).child.status,
      'paused',
    );

    process.stdout.write(
      '执行内核 Phase 6 回归通过：Checkpoint Transition、累计预算、批准 Journal、父子 Run 与幂等恢复稳定。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`执行内核 Phase 6 回归失败：${errorMessage(error)}\n`);
    return 1;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
    rmSync(path.join(executionsRoot, cliParentRunId), { force: true, recursive: true });
    rmSync(path.join(executionsRoot, cliChildRunId), { force: true, recursive: true });
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
