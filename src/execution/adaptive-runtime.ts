import { createHash } from 'node:crypto';
import type { PluginJsonObject } from '../contracts/json.js';
import {
  EXECUTION_EVENT_SCHEMA_VERSION,
  WORKFLOW_AUTHORING_SCHEMA_VERSION,
  WORKFLOW_EXECUTION_MODES,
  WORKFLOW_TRANSITION_SCHEMA_VERSION,
  type ExecutionEvent,
  type ExecutionJournalStore,
  type WorkflowAdaptiveBudgetReservation,
  type WorkflowAdaptiveLimits,
  type WorkflowDefinition,
  type WorkflowExecutionMode,
  type WorkflowTransitionApproval,
  type WorkflowTransitionParent,
  type WorkflowTransitionPreview,
  type WorkflowTransitionRequest,
  type WorkflowTransitionRunResult,
} from '../contracts/execution.js';
import {
  compileStaticExecutionPlan,
  hashPortableJson,
  serializeCanonicalJson,
  validateWorkflowTransitionRequest,
} from '../core/execution-plan.js';
import { calculateExecutionEventHash } from './file-journal.js';
import { inspectSettledWorkflowRun } from './serial-runner.js';
import {
  parseWorkflowDefinitionOutput,
  previewWorkflowDefinition,
  runApprovedWorkflowWithTransitionContext,
  type ApprovedWorkflowExecutionOptions,
} from './workflow-authoring.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const objectValue = (value: unknown, label: string): JsonRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as JsonRecord;
};

const stringValue = (record: JsonRecord, key: string, label: string): string => {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`${label}.${key} 必须是字符串`);
  }
  return value;
};

const integerValue = (record: JsonRecord, key: string, label: string): number => {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label}.${key} 必须是非负整数`);
  }
  return value as number;
};

const clonePortable = <T>(value: T): T =>
  JSON.parse(serializeCanonicalJson(value)) as T;

const freezePortable = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as JsonRecord).forEach((nested) => freezePortable(nested));
  }
  return value;
};

export interface CreateWorkflowTransitionOptions {
  readonly executionMode: WorkflowExecutionMode;
  readonly limits: WorkflowAdaptiveLimits;
  readonly transitionId: string;
}

/** Creates a strict portable transition request without executing either workflow. */
export const createWorkflowTransitionRequest = (
  parent: WorkflowTransitionParent,
  definition: unknown,
  options: CreateWorkflowTransitionOptions,
): WorkflowTransitionRequest => {
  const request: WorkflowTransitionRequest = {
    definition: parseWorkflowDefinitionOutput(definition),
    executionMode: options.executionMode,
    kind: 'workflow-transition',
    limits: clonePortable(options.limits),
    parent: clonePortable(parent),
    schemaVersion: WORKFLOW_TRANSITION_SCHEMA_VERSION,
    transitionId: options.transitionId,
  };
  const findings = validateWorkflowTransitionRequest(request);
  if (findings.length > 0) {
    throw new Error(`Workflow Transition 无效：\n- ${findings.join('\n- ')}`);
  }
  return freezePortable(clonePortable(request));
};

interface ParentState {
  readonly events: readonly ExecutionEvent[];
  readonly existingTransition?: JsonRecord;
  readonly mode: WorkflowExecutionMode;
}

const inspectParent = (
  request: WorkflowTransitionRequest,
  parentDefinition: WorkflowDefinition,
  store: ExecutionJournalStore,
): ParentState => {
  if (store.runId !== request.parent.runId) {
    throw new Error('Workflow Transition parent.runId 与 Parent Journal 不一致');
  }
  const plan = compileStaticExecutionPlan(parentDefinition);
  if (
    plan.workflowId !== request.parent.workflowId ||
    plan.workflowHash !== request.parent.workflowHash
  ) {
    throw new Error('Workflow Transition Parent Definition 身份不一致');
  }
  const checkpointNode = parentDefinition.nodes.find(({ id }) =>
    id === request.parent.checkpointNodeId);
  if (checkpointNode?.type !== 'checkpoint') {
    throw new Error('Workflow Transition 必须引用 Parent Definition 中的 checkpoint 节点');
  }
  const events = store.readEvents();
  if (events.length === 0 || events[0]?.type !== 'run.created') {
    throw new Error('Parent Run 不存在或 Journal 不完整');
  }
  if (events.some((event) =>
    event.runId !== store.runId ||
    event.workflowId !== plan.workflowId ||
    event.workflowHash !== plan.workflowHash)) {
    throw new Error('Parent Journal 与 Transition Parent 身份不一致');
  }
  const started = events.find(({ type }) => type === 'run.started');
  const startedPayload = objectValue(started?.payload, 'run.started.payload');
  const mode = stringValue(startedPayload, 'mode', 'run.started.payload');
  if (!WORKFLOW_EXECUTION_MODES.includes(mode as WorkflowExecutionMode)) {
    throw new Error('Parent Run executionMode 不受支持');
  }
  const checkpointIndex = events.findLastIndex((event) => {
    if (event.type !== 'run.checkpointed') {
      return false;
    }
    const payload = objectValue(event.payload, 'run.checkpointed.payload');
    return payload.checkpointNodeId === request.parent.checkpointNodeId;
  });
  if (checkpointIndex < 0) {
    throw new Error('Parent Run 尚未到达指定 Checkpoint');
  }
  const paused = events[checkpointIndex + 1];
  const pausedPayload = objectValue(paused?.payload, 'run.paused.payload');
  if (
    paused?.type !== 'run.paused' ||
    pausedPayload.reason !== 'checkpoint' ||
    pausedPayload.checkpointNodeId !== request.parent.checkpointNodeId
  ) {
    throw new Error('Parent Run 的 Checkpoint 暂停边界不完整');
  }
  const trailing = events.slice(checkpointIndex + 2);
  if (trailing.length === 0) {
    return { events, mode: mode as WorkflowExecutionMode };
  }
  if (trailing.length !== 1 || trailing[0]?.type !== 'run.transitioned') {
    throw new Error('Parent Run 在 Checkpoint 后已被恢复或以其他方式终止');
  }
  const existingTransition = objectValue(
    trailing[0].payload,
    'run.transitioned.payload',
  );
  if (
    existingTransition.outcome !== 'transitioned' ||
    existingTransition.transitionId !== request.transitionId
  ) {
    throw new Error('Parent Run 已由其他 Transition 收口');
  }
  return {
    events,
    existingTransition,
    mode: mode as WorkflowExecutionMode,
  };
};

const reservationFor = (
  definition: WorkflowDefinition,
  executionMode: WorkflowExecutionMode,
): WorkflowAdaptiveBudgetReservation => {
  const preview = previewWorkflowDefinition(definition, executionMode);
  return {
    definitions: 1,
    depth: 0,
    totalAgents: preview.plan.limits.maxAgents,
    totalDurationMs: preview.plan.limits.maxDurationMs,
    totalExecutorCalls: preview.budget.maxExecutorCalls,
    totalExternalWrites: preview.plan.limits.maxExternalWrites,
  };
};

const inheritedReservation = (
  state: ParentState,
  parentDefinition: WorkflowDefinition,
  limits: WorkflowAdaptiveLimits,
): WorkflowAdaptiveBudgetReservation => {
  const approval = [...state.events]
    .reverse()
    .find(({ type }) => type === 'run.plan-approved');
  if (!approval) {
    return reservationFor(parentDefinition, state.mode);
  }
  const payload = objectValue(approval.payload, 'run.plan-approved.payload');
  if (payload.transition === undefined) {
    return reservationFor(parentDefinition, state.mode);
  }
  const transition = objectValue(payload.transition, 'run.plan-approved.payload.transition');
  const inheritedLimits = objectValue(
    transition.limits,
    'run.plan-approved.payload.transition.limits',
  );
  if (serializeCanonicalJson(inheritedLimits) !== serializeCanonicalJson(limits)) {
    throw new Error('Workflow Transition 不允许扩大或替换既有自适应预算');
  }
  const cumulative = objectValue(
    transition.cumulativeBudget,
    'run.plan-approved.payload.transition.cumulativeBudget',
  );
  const reservation: WorkflowAdaptiveBudgetReservation = {
    definitions: integerValue(cumulative, 'definitions', 'cumulativeBudget'),
    depth: integerValue(cumulative, 'depth', 'cumulativeBudget'),
    totalAgents: integerValue(cumulative, 'totalAgents', 'cumulativeBudget'),
    totalDurationMs: integerValue(cumulative, 'totalDurationMs', 'cumulativeBudget'),
    totalExecutorCalls: integerValue(cumulative, 'totalExecutorCalls', 'cumulativeBudget'),
    totalExternalWrites: integerValue(cumulative, 'totalExternalWrites', 'cumulativeBudget'),
  };
  if (integerValue(transition, 'depth', 'transition') !== reservation.depth) {
    throw new Error('Parent Transition depth 与累计预算不一致');
  }
  const current = reservationFor(parentDefinition, state.mode);
  if (
    reservation.definitions !== reservation.depth + 1 ||
    reservation.totalAgents < current.totalAgents ||
    reservation.totalDurationMs < current.totalDurationMs ||
    reservation.totalExecutorCalls < current.totalExecutorCalls ||
    reservation.totalExternalWrites < current.totalExternalWrites
  ) {
    throw new Error('Parent Transition 累计预算不能证明当前 Parent Definition 的预留');
  }
  return reservation;
};

const addReservation = (
  parent: WorkflowAdaptiveBudgetReservation,
  child: WorkflowAdaptiveBudgetReservation,
): WorkflowAdaptiveBudgetReservation => ({
  definitions: parent.definitions + 1,
  depth: parent.depth + 1,
  totalAgents: parent.totalAgents + child.totalAgents,
  totalDurationMs: parent.totalDurationMs + child.totalDurationMs,
  totalExecutorCalls: parent.totalExecutorCalls + child.totalExecutorCalls,
  totalExternalWrites: parent.totalExternalWrites + child.totalExternalWrites,
});

const budgetFindings = (
  budget: WorkflowAdaptiveBudgetReservation,
  limits: WorkflowAdaptiveLimits,
): string[] => [
  budget.depth > limits.maxDepth ? `depth ${budget.depth}/${limits.maxDepth}` : '',
  budget.totalAgents > limits.maxTotalAgents
    ? `totalAgents ${budget.totalAgents}/${limits.maxTotalAgents}` : '',
  budget.totalDurationMs > limits.maxTotalDurationMs
    ? `totalDurationMs ${budget.totalDurationMs}/${limits.maxTotalDurationMs}` : '',
  budget.totalExecutorCalls > limits.maxTotalExecutorCalls
    ? `totalExecutorCalls ${budget.totalExecutorCalls}/${limits.maxTotalExecutorCalls}` : '',
  budget.totalExternalWrites > limits.maxTotalExternalWrites
    ? `totalExternalWrites ${budget.totalExternalWrites}/${limits.maxTotalExternalWrites}` : '',
].filter(Boolean).sort(compareStrings);

export interface WorkflowTransitionPreviewOptions {
  readonly parentDefinition: unknown;
  readonly parentStore: ExecutionJournalStore;
}

/** Previews one checkpoint-bound child run and enforces the cumulative lineage budget. */
export const previewWorkflowTransition = (
  value: unknown,
  options: WorkflowTransitionPreviewOptions,
): WorkflowTransitionPreview => {
  const findings = validateWorkflowTransitionRequest(value);
  if (findings.length > 0) {
    throw new Error(`Workflow Transition 无效：\n- ${findings.join('\n- ')}`);
  }
  const request = freezePortable(clonePortable(value as WorkflowTransitionRequest));
  const parentDefinition = parseWorkflowDefinitionOutput(options.parentDefinition);
  const state = inspectParent(request, parentDefinition, options.parentStore);
  const child = previewWorkflowDefinition(request.definition, request.executionMode);
  const cumulativeBudget = addReservation(
    inheritedReservation(state, parentDefinition, request.limits),
    reservationFor(request.definition, request.executionMode),
  );
  const exceeded = budgetFindings(cumulativeBudget, request.limits);
  if (exceeded.length > 0) {
    throw new Error(`Workflow Transition 累计预算超限：\n- ${exceeded.join('\n- ')}`);
  }
  const previewWithoutHash = {
    child,
    cumulativeBudget,
    limits: request.limits,
    parent: request.parent,
    schemaVersion: WORKFLOW_TRANSITION_SCHEMA_VERSION,
    transitionId: request.transitionId,
  };
  const preview = freezePortable({
    ...previewWithoutHash,
    transitionHash: hashPortableJson(previewWithoutHash),
  });
  if (
    state.existingTransition &&
    state.existingTransition.transitionHash !== preview.transitionHash
  ) {
    throw new Error('Parent Run 已由内容不同的 Transition 收口');
  }
  return preview;
};

/** Strictly binds a host approval to the parent, child preview and execution mode. */
export const validateWorkflowTransitionApproval = (
  preview: WorkflowTransitionPreview,
  value: unknown,
): string[] => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['Transition 批准回执必须是对象'];
  }
  const approval = value as JsonRecord;
  const expectedKeys = [
    'childPreviewHash',
    'executionMode',
    'parentWorkflowHash',
    'schemaVersion',
    'transitionHash',
  ];
  const keys = Object.keys(approval).sort(compareStrings);
  const findings: string[] = [];
  if (serializeCanonicalJson(keys) !== serializeCanonicalJson(expectedKeys)) {
    findings.push('Transition 批准字段不完整或包含未知字段');
  }
  if (approval.schemaVersion !== WORKFLOW_TRANSITION_SCHEMA_VERSION) {
    findings.push('Transition 批准 schemaVersion 不受支持');
  }
  if (approval.executionMode !== preview.child.executionMode) {
    findings.push('Transition 批准 executionMode 不一致');
  }
  if (
    typeof approval.parentWorkflowHash !== 'string' ||
    !SHA256_PATTERN.test(approval.parentWorkflowHash) ||
    approval.parentWorkflowHash !== preview.parent.workflowHash
  ) {
    findings.push('Transition 批准 parentWorkflowHash 不一致');
  }
  if (
    typeof approval.childPreviewHash !== 'string' ||
    !SHA256_PATTERN.test(approval.childPreviewHash) ||
    approval.childPreviewHash !== preview.child.previewHash
  ) {
    findings.push('Transition 批准 childPreviewHash 不一致');
  }
  if (
    typeof approval.transitionHash !== 'string' ||
    !SHA256_PATTERN.test(approval.transitionHash) ||
    approval.transitionHash !== preview.transitionHash
  ) {
    findings.push('Transition 批准 transitionHash 不一致');
  }
  return findings.sort(compareStrings);
};

const artifactToJson = (reference: {
  readonly byteLength: number;
  readonly id: string;
  readonly mediaType: 'application/json';
  readonly sha256: string;
}): PluginJsonObject => ({
  byteLength: reference.byteLength,
  id: reference.id,
  mediaType: reference.mediaType,
  sha256: reference.sha256,
});

const appendTransitionCompletion = (
  preview: WorkflowTransitionPreview,
  parentStore: ExecutionJournalStore,
  childRunId: string,
  now: () => Date,
): number => {
  let events = parentStore.readEvents();
  const existing = events.at(-1);
  if (existing?.type === 'run.transitioned') {
    const payload = objectValue(existing.payload, 'run.transitioned.payload');
    if (
      payload.outcome === 'transitioned' &&
      payload.transitionHash === preview.transitionHash &&
      payload.childRunId === childRunId
    ) {
      return events.length;
    }
    throw new Error('Parent Run 已被其他 Transition 收口');
  }
  if (existing?.type !== 'run.paused') {
    throw new Error('Parent Run 不再处于可 Transition 的 Checkpoint 暂停状态');
  }
  const activation = {
    childPreviewHash: preview.child.previewHash,
    childRunId,
    childWorkflowHash: preview.child.workflowHash,
    childWorkflowId: preview.child.workflowId,
    kind: 'workflow-transition-activation',
    parentRunId: preview.parent.runId,
    transitionHash: preview.transitionHash,
    transitionId: preview.transitionId,
  };
  const resultArtifact = parentStore.writeJsonArtifact(activation);
  const payload: PluginJsonObject = {
    ...activation,
    outcome: 'transitioned',
    resultArtifact: artifactToJson(resultArtifact),
  };
  const sequence = events.length;
  const timestamp = now().toISOString();
  const previousEventHash = events.at(-1)?.eventHash ?? null;
  const eventIdSeed = serializeCanonicalJson({
    payload,
    previousEventHash,
    runId: parentStore.runId,
    sequence,
    timestamp,
    type: 'run.transitioned',
  });
  const draft: ExecutionEvent = {
    eventId: `event-${createHash('sha256').update(eventIdSeed).digest('hex').slice(0, 32)}`,
    payload,
    previousEventHash,
    runId: parentStore.runId,
    schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    sequence,
    timestamp,
    type: 'run.transitioned',
    workflowHash: preview.parent.workflowHash,
    workflowId: preview.parent.workflowId,
  };
  const event: ExecutionEvent = Object.freeze({
    ...draft,
    eventHash: calculateExecutionEventHash(draft),
  });
  try {
    parentStore.append(event);
  } catch (error: unknown) {
    events = parentStore.readEvents();
    const winner = events.at(-1);
    const winnerPayload = winner?.type === 'run.transitioned'
      ? objectValue(winner.payload, 'run.transitioned.payload')
      : undefined;
    if (
      winnerPayload?.outcome === 'transitioned' &&
      winnerPayload.transitionHash === preview.transitionHash &&
      winnerPayload.childRunId === childRunId
    ) {
      return events.length;
    }
    throw error;
  }
  return sequence + 1;
};

const validateChildStoreReuse = (
  preview: WorkflowTransitionPreview,
  childStore: ExecutionJournalStore,
  input: unknown,
): boolean => {
  const events = childStore.readEvents();
  if (events.length === 0) {
    return false;
  }
  if (
    events[0]?.type !== 'run.created' ||
    events.some((event) =>
      event.runId !== childStore.runId ||
      event.workflowId !== preview.child.workflowId ||
      event.workflowHash !== preview.child.workflowHash)
  ) {
    throw new Error('Child Run ID 已被其他 Workflow 使用');
  }
  const approvals = events.filter(({ type }) => type === 'run.plan-approved');
  if (approvals.length !== 1) {
    throw new Error('既有 Child Run 缺少唯一的批准 Journal');
  }
  const approval = objectValue(approvals[0]?.payload, 'run.plan-approved.payload');
  const transition = objectValue(
    approval.transition,
    'run.plan-approved.payload.transition',
  );
  if (
    approval.previewHash !== preview.child.previewHash ||
    transition.transitionHash !== preview.transitionHash ||
    transition.parentRunId !== preview.parent.runId
  ) {
    throw new Error('既有 Child Run 的 Transition 批准上下文不匹配');
  }
  const created = objectValue(events[0]?.payload, 'run.created.payload');
  if (created.inputHash !== hashPortableJson(input)) {
    throw new Error('既有 Child Run 的 input 与当前 Transition 调用不匹配');
  }
  const started = events.find(({ type }) => type === 'run.started');
  const startedPayload = objectValue(started?.payload, 'run.started.payload');
  if (startedPayload.mode !== preview.child.executionMode) {
    throw new Error('既有 Child Run 的 executionMode 与当前 Transition 不匹配');
  }
  return true;
};

export interface ApprovedWorkflowTransitionOptions
  extends Omit<
    ApprovedWorkflowExecutionOptions,
    'approval' | 'definition' | 'executionMode' | 'mode' | 'store'
  > {
  readonly approval: WorkflowTransitionApproval;
  readonly childStore: ExecutionJournalStore;
  readonly parentDefinition: unknown;
  readonly parentStore: ExecutionJournalStore;
  readonly request: unknown;
}

/** Atomically retires a checkpointed parent segment, then starts or resumes its approved child. */
export const runApprovedWorkflowTransition = async (
  options: ApprovedWorkflowTransitionOptions,
): Promise<WorkflowTransitionRunResult> => {
  if (options.childStore.runId === options.parentStore.runId) {
    throw new Error('Workflow Transition 的 Parent 和 Child Run ID 必须不同');
  }
  const preview = previewWorkflowTransition(options.request, {
    parentDefinition: options.parentDefinition,
    parentStore: options.parentStore,
  });
  const approvalFindings = validateWorkflowTransitionApproval(preview, options.approval);
  if (approvalFindings.length > 0) {
    throw new Error(`Workflow Transition 未获当前预览批准：\n- ${approvalFindings.join('\n- ')}`);
  }
  const request = freezePortable(clonePortable(options.request as WorkflowTransitionRequest));
  const childHasEvents = validateChildStoreReuse(preview, options.childStore, options.input);
  const parentEventCount = appendTransitionCompletion(
    preview,
    options.parentStore,
    options.childStore.runId,
    options.now ?? (() => new Date()),
  );
  const settledChild = childHasEvents
    ? inspectSettledWorkflowRun(request.definition, options.childStore)
    : undefined;
  const child = settledChild ?? await runApprovedWorkflowWithTransitionContext({
    ...(options.approvedCheckpoints
      ? { approvedCheckpoints: options.approvedCheckpoints }
      : {}),
    approval: {
      executionMode: preview.child.executionMode,
      previewHash: preview.child.previewHash,
      schemaVersion: WORKFLOW_AUTHORING_SCHEMA_VERSION,
      workflowHash: preview.child.workflowHash,
    },
    definition: request.definition,
    executionMode: request.executionMode,
    executor: options.executor,
    input: options.input,
    mode: childHasEvents ? 'resume' : 'start',
    ...(options.now ? { now: options.now } : {}),
    ...(options.serialFallback ? { serialFallback: options.serialFallback } : {}),
    store: options.childStore,
    ...(options.workspace ? { workspace: options.workspace } : {}),
  }, {
    checkpointNodeId: preview.parent.checkpointNodeId,
    cumulativeBudget: preview.cumulativeBudget,
    depth: preview.cumulativeBudget.depth,
    limits: preview.limits,
    parentRunId: preview.parent.runId,
    parentWorkflowHash: preview.parent.workflowHash,
    parentWorkflowId: preview.parent.workflowId,
    transitionHash: preview.transitionHash,
    transitionId: preview.transitionId,
  });
  return freezePortable({ child, parentEventCount, preview });
};
