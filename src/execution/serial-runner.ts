import { createHash } from 'node:crypto';
import type { PluginJsonObject, PluginJsonValue } from '../contracts/json.js';
import type { PluginPermission } from '../contracts/plugin.js';
import {
  AGENT_EXECUTOR_API_VERSION,
  EXECUTION_EVENT_SCHEMA_VERSION,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentExecutorCapabilities,
  type AgentExecutorService,
  type AgentWorkflowNode,
  type ExecutionArtifactReference,
  type ExecutionControlResult,
  type ExecutionEvent,
  type ExecutionEventType,
  type ExecutionJournalStore,
  type ExecutionRunError,
  type ExecutionRunNodeSummary,
  type ExecutionRunResult,
  type StaticExecutionPlan,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../contracts/execution.js';
import {
  compileStaticExecutionPlan,
  hashPortableJson,
  serializeCanonicalJson,
  validateJsonValue,
} from '../core/execution-plan.js';
import { errorMessage } from '../types/guards.js';
import { calculateExecutionEventHash } from './file-journal.js';

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_TOOL_CALLS = 50;
const EXECUTOR_CANCEL_GRACE_MS = 1000;
const SAFE_PHASE_ONE_PERMISSIONS = new Set<PluginPermission>([
  'artifact:read',
  'workspace:read',
]);
const TERMINAL_EVENT_TYPES = new Set<ExecutionEventType>([
  'run.cancelled',
  'run.completed',
  'run.failed',
]);

export interface SerialExecutionOptions {
  readonly approvedCheckpoints?: readonly string[];
  readonly definition: unknown;
  readonly executor: AgentExecutorService;
  readonly input: unknown;
  readonly mode?: 'resume' | 'start';
  readonly now?: () => Date;
  readonly store: ExecutionJournalStore;
}

interface NodeReplayState {
  artifact?: ExecutionArtifactReference;
  completed: boolean;
  maxScheduledAttempt: number;
  maxStartedAttempt: number;
}

interface RunIdentity {
  inputArtifact: ExecutionArtifactReference;
  inputHash: string;
}

class ExecutionTimeoutError extends Error {}

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
};

const stringValue = (record: Record<string, unknown>, key: string, label: string): string => {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`${label}.${key} 必须是字符串`);
  }
  return value;
};

const artifactToJson = (reference: ExecutionArtifactReference): PluginJsonObject => ({
  byteLength: reference.byteLength,
  id: reference.id,
  mediaType: reference.mediaType,
  sha256: reference.sha256,
});

const artifactFromJson = (value: unknown, label: string): ExecutionArtifactReference => {
  const record = objectValue(value, label);
  const byteLength = record.byteLength;
  const mediaType = record.mediaType;
  if (!Number.isInteger(byteLength) || (byteLength as number) < 0) {
    throw new Error(`${label}.byteLength 必须是非负整数`);
  }
  if (mediaType !== 'application/json') {
    throw new Error(`${label}.mediaType 必须是 application/json`);
  }
  return Object.freeze({
    byteLength: byteLength as number,
    id: stringValue(record, 'id', label),
    mediaType,
    sha256: stringValue(record, 'sha256', label),
  });
};

const usageToJson = (usage: AgentExecutionResult['usage']): PluginJsonObject => ({
  durationMs: usage.durationMs,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  toolCalls: usage.toolCalls,
});

class EventWriter {
  readonly #now: () => Date;
  readonly #plan: StaticExecutionPlan;
  readonly #store: ExecutionJournalStore;
  readonly events: ExecutionEvent[];

  constructor(
    plan: StaticExecutionPlan,
    store: ExecutionJournalStore,
    now: () => Date,
    existingEvents: readonly ExecutionEvent[],
  ) {
    this.#plan = plan;
    this.#store = store;
    this.#now = now;
    this.events = [...existingEvents];
  }

  emit(
    type: ExecutionEventType,
    payload: PluginJsonObject,
    node?: { attempt: number; nodeId: string },
  ): ExecutionEvent {
    const sequence = this.events.length;
    const timestamp = this.#now().toISOString();
    const previousEventHash = this.events.at(-1)?.eventHash ?? null;
    const eventIdSeed = serializeCanonicalJson({
      attempt: node?.attempt ?? null,
      nodeId: node?.nodeId ?? null,
      payload,
      previousEventHash,
      runId: this.#store.runId,
      sequence,
      timestamp,
      type,
    });
    const eventId = `event-${createHash('sha256').update(eventIdSeed).digest('hex').slice(0, 32)}`;
    const draft: ExecutionEvent = {
      eventId,
      payload,
      previousEventHash,
      runId: this.#store.runId,
      schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
      sequence,
      timestamp,
      type,
      workflowHash: this.#plan.workflowHash,
      workflowId: this.#plan.workflowId,
      ...(node ? { attempt: node.attempt, nodeId: node.nodeId } : {}),
    };
    const event: ExecutionEvent = Object.freeze({
      ...draft,
      eventHash: calculateExecutionEventHash(draft),
    });
    this.#store.append(event);
    this.events.push(event);
    return event;
  }
}

const phaseOnePolicyFindings = (definition: WorkflowDefinition): string[] => {
  const findings: string[] = [];
  if (definition.limits.maxExternalWrites !== 0) {
    findings.push('Phase 1 要求 limits.maxExternalWrites 为 0');
  }
  for (const node of definition.nodes) {
    if (node.type !== 'agent') {
      continue;
    }
    if (node.workspace?.mode === 'exclusive-worktree') {
      findings.push(`节点 ${node.id}：Phase 1 不支持可写或独占 Worktree`);
    }
    if (node.workspace?.repository) {
      findings.push(`节点 ${node.id}：Phase 1 尚未开放 repository binding`);
    }
    const unsafePermissions = (node.permissions ?? [])
      .filter((permission) => !SAFE_PHASE_ONE_PERMISSIONS.has(permission))
      .sort();
    if (unsafePermissions.length > 0) {
      findings.push(`节点 ${node.id}：Phase 1 不允许权限 ${unsafePermissions.join(', ')}`);
    }
  }
  return findings.sort();
};

const capabilityStructureFinding = (value: unknown): string | undefined => {
  try {
    hashPortableJson(value, 64 * 1024);
    const record = objectValue(value, 'Executor Capabilities');
    const features = objectValue(record.features, 'Executor Capabilities.features');
    const featureKeys = [
      'cancellation',
      'modelRouting',
      'persistentResume',
      'structuredOutput',
      'toolAllowlist',
      'usageReporting',
      'workspaceIsolation',
    ];
    if (
      record.apiVersion !== AGENT_EXECUTOR_API_VERSION ||
      !Number.isInteger(record.maxConcurrency) ||
      (record.maxConcurrency as number) < 1 ||
      featureKeys.some((key) => typeof features[key] !== 'boolean') ||
      (record.capabilities !== undefined && (
        !Array.isArray(record.capabilities) ||
        record.capabilities.some((item) => typeof item !== 'string')
      )) ||
      (record.models !== undefined && (
        !Array.isArray(record.models) ||
        record.models.some((item) => typeof item !== 'string')
      ))
    ) {
      return 'Executor Capabilities 字段无效';
    }
    return undefined;
  } catch {
    return 'Executor Capabilities 不是有效的可移植 JSON';
  }
};

const resultStructureFinding = (value: unknown): string | undefined => {
  try {
    hashPortableJson(value, 256 * 1024);
    const record = objectValue(value, 'Executor Result');
    const executor = objectValue(record.executor, 'Executor Result.executor');
    const usage = objectValue(record.usage, 'Executor Result.usage');
    const nullableCount = (item: unknown): boolean =>
      item === null || (Number.isInteger(item) && (item as number) >= 0);
    if (
      record.apiVersion !== AGENT_EXECUTOR_API_VERSION ||
      typeof record.runId !== 'string' ||
      typeof record.nodeId !== 'string' ||
      !Number.isInteger(record.attempt) ||
      !['blocked', 'cancelled', 'failed', 'succeeded'].includes(String(record.status)) ||
      typeof record.retryable !== 'boolean' ||
      typeof executor.id !== 'string' ||
      !Array.isArray(record.artifacts) ||
      record.artifacts.some((item) => typeof item !== 'string') ||
      !Array.isArray(record.findings) ||
      !Number.isFinite(usage.durationMs) ||
      (usage.durationMs as number) < 0 ||
      !nullableCount(usage.inputTokens) ||
      !nullableCount(usage.outputTokens) ||
      !nullableCount(usage.toolCalls)
    ) {
      return 'Executor Result 字段无效';
    }
    for (const finding of record.findings) {
      const findingRecord = objectValue(finding, 'Executor Result.findings[]');
      if (
        typeof findingRecord.code !== 'string' ||
        typeof findingRecord.message !== 'string' ||
        !['error', 'info', 'warning'].includes(String(findingRecord.severity)) ||
        (findingRecord.path !== undefined && typeof findingRecord.path !== 'string')
      ) {
        return 'Executor Result finding 字段无效';
      }
    }
    if (record.error !== undefined) {
      const error = objectValue(record.error, 'Executor Result.error');
      if (typeof error.code !== 'string' || typeof error.message !== 'string') {
        return 'Executor Result error 字段无效';
      }
    }
    return undefined;
  } catch {
    return 'Executor Result 不是有效的可移植 JSON';
  }
};

const supportedCapabilities = (capabilities: AgentExecutorCapabilities): Set<string> => {
  const supported = new Set(capabilities.capabilities ?? []);
  const features: ReadonlyArray<[keyof AgentExecutorCapabilities['features'], string]> = [
    ['cancellation', 'cancellation'],
    ['modelRouting', 'model-routing'],
    ['persistentResume', 'persistent-resume'],
    ['structuredOutput', 'structured-output'],
    ['toolAllowlist', 'tool-allowlist'],
    ['usageReporting', 'usage-reporting'],
    ['workspaceIsolation', 'workspace-isolation'],
  ];
  for (const [key, name] of features) {
    if (capabilities.features[key]) {
      supported.add(name);
    }
  }
  return supported;
};

const executorCompatibilityFindings = (
  definition: WorkflowDefinition,
  capabilities: AgentExecutorCapabilities,
): { errors: string[]; degraded: string[] } => {
  const errors: string[] = [];
  const degraded: string[] = [];
  if (capabilities.apiVersion !== AGENT_EXECUTOR_API_VERSION) {
    errors.push(`Executor API 版本不兼容：${capabilities.apiVersion}`);
  }
  if (!Number.isInteger(capabilities.maxConcurrency) || capabilities.maxConcurrency < 1) {
    errors.push('Executor maxConcurrency 必须至少为 1');
  }
  const supported = supportedCapabilities(capabilities);
  for (const node of definition.nodes) {
    if (node.type !== 'agent') {
      continue;
    }
    const missingRequired = (node.requiredCapabilities ?? [])
      .filter((capability) => !supported.has(capability))
      .sort();
    if (missingRequired.length > 0) {
      errors.push(`节点 ${node.id} 缺少 required capability：${missingRequired.join(', ')}`);
    }
    degraded.push(...(node.preferredCapabilities ?? [])
      .filter((capability) => !supported.has(capability))
      .map((capability) => `${node.id}:${capability}`));
  }
  return { errors: errors.sort(), degraded: [...new Set(degraded)].sort() };
};

const describeExecutor = async (
  executor: AgentExecutorService,
): Promise<AgentExecutorCapabilities> => {
  const value: unknown = await executor.describe();
  const finding = capabilityStructureFinding(value);
  if (finding) {
    throw new Error(finding);
  }
  return value as AgentExecutorCapabilities;
};

const validateEventIdentity = (
  events: readonly ExecutionEvent[],
  plan: StaticExecutionPlan,
  runId: string,
): void => {
  for (const event of events) {
    if (
      event.runId !== runId ||
      event.workflowHash !== plan.workflowHash ||
      event.workflowId !== plan.workflowId
    ) {
      throw new Error('Journal 与当前 Run/Workflow 身份不匹配');
    }
  }
  const terminalIndex = events.findIndex(({ type }) => TERMINAL_EVENT_TYPES.has(type));
  if (terminalIndex >= 0 && terminalIndex !== events.length - 1) {
    throw new Error('Journal 在终止事件之后仍包含事件');
  }
};

const replayNodeStates = (
  definition: WorkflowDefinition,
  events: readonly ExecutionEvent[],
): Map<string, NodeReplayState> => {
  const states = new Map<string, NodeReplayState>(definition.nodes.map(({ id }) => [id, {
    completed: false,
    maxScheduledAttempt: 0,
    maxStartedAttempt: 0,
  }]));
  for (const event of events) {
    if (!event.nodeId || !event.attempt) {
      continue;
    }
    const state = states.get(event.nodeId);
    if (!state) {
      throw new Error(`Journal 引用了定义中不存在的节点：${event.nodeId}`);
    }
    if (event.type === 'node.scheduled' || event.type === 'node.retry-scheduled') {
      state.maxScheduledAttempt = Math.max(state.maxScheduledAttempt, event.attempt);
    }
    if (event.type === 'node.started') {
      state.maxStartedAttempt = Math.max(state.maxStartedAttempt, event.attempt);
    }
    if (event.type === 'node.completed') {
      state.completed = true;
      state.artifact = artifactFromJson(
        objectValue(event.payload, 'node.completed.payload').artifact,
        'node.completed.payload.artifact',
      );
    }
  }
  return states;
};

const nextAttempt = (state: NodeReplayState): number => {
  if (state.maxScheduledAttempt > state.maxStartedAttempt) {
    return state.maxScheduledAttempt;
  }
  return state.maxStartedAttempt + 1;
};

const runIdentityFromCreated = (event: ExecutionEvent): RunIdentity => {
  if (event.type !== 'run.created') {
    throw new Error('Journal 第一条事件必须是 run.created');
  }
  const payload = objectValue(event.payload, 'run.created.payload');
  return {
    inputArtifact: artifactFromJson(payload.inputArtifact, 'run.created.payload.inputArtifact'),
    inputHash: stringValue(payload, 'inputHash', 'run.created.payload'),
  };
};

const activeDurationMs = (events: readonly ExecutionEvent[], now: Date): number => {
  let activeSince: number | undefined;
  let duration = 0;
  let lastTimestamp: number | undefined;
  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) {
      throw new Error('Journal 包含非法 timestamp');
    }
    if (event.type === 'run.resumed' && activeSince !== undefined) {
      // A resume without a preceding pause represents process recovery; downtime is not active time.
      duration += Math.max(0, (lastTimestamp ?? timestamp) - activeSince);
      activeSince = timestamp;
    } else if (event.type === 'run.started' || event.type === 'run.resumed') {
      if (activeSince === undefined) {
        activeSince = timestamp;
      }
    }
    if (
      event.type === 'run.paused' ||
      event.type === 'run.cancelled' ||
      event.type === 'run.completed' ||
      event.type === 'run.failed'
    ) {
      if (activeSince !== undefined) {
        duration += Math.max(0, timestamp - activeSince);
        activeSince = undefined;
      }
    }
    lastTimestamp = timestamp;
  }
  if (activeSince !== undefined) {
    duration += Math.max(0, now.getTime() - activeSince);
  }
  return duration;
};

const executeWithTimeout = async (
  executor: AgentExecutorService,
  request: AgentExecutionRequest,
  timeoutMs: number,
): Promise<AgentExecutionResult> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ExecutionTimeoutError('Agent 执行超时')), timeoutMs);
  });
  try {
    return await Promise.race([executor.execute(request), timeout]);
  } catch (error: unknown) {
    if (error instanceof ExecutionTimeoutError && executor.cancel) {
      let cancelTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          executor.cancel({
            apiVersion: AGENT_EXECUTOR_API_VERSION,
            attempt: request.attempt,
            nodeId: request.nodeId,
            runId: request.runId,
          }),
          new Promise<void>((resolve) => {
            cancelTimer = setTimeout(resolve, EXECUTOR_CANCEL_GRACE_MS);
          }),
        ]);
      } catch {
        // Cancellation is best-effort; timeout classification remains authoritative.
      } finally {
        if (cancelTimer) {
          clearTimeout(cancelTimer);
        }
      }
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const resultFailure = (
  result: AgentExecutionResult,
  request: AgentExecutionRequest,
): { code: string; message: string; retryable: boolean } | undefined => {
  if (
    result.apiVersion !== AGENT_EXECUTOR_API_VERSION ||
    result.runId !== request.runId ||
    result.nodeId !== request.nodeId ||
    result.attempt !== request.attempt
  ) {
    return { code: 'invalid-output', message: 'Executor Result 身份与请求不匹配', retryable: false };
  }
  if (result.usage.toolCalls !== null && result.usage.toolCalls > request.limits.maxToolCalls) {
    return { code: 'budget-exhausted', message: 'Executor 超过工具调用预算', retryable: false };
  }
  if (result.status === 'failed') {
    return {
      code: result.error?.code ?? 'unknown',
      message: result.error?.message ?? 'Executor 返回 failed',
      retryable: result.retryable,
    };
  }
  return undefined;
};

const dependencyArtifacts = (
  node: WorkflowNode,
  states: ReadonlyMap<string, NodeReplayState>,
): ExecutionArtifactReference[] => (node.dependsOn ?? [])
  .map((id) => {
    const artifact = states.get(id)?.artifact;
    if (!artifact) {
      throw new Error(`节点 ${node.id} 的依赖 ${id} 尚未完成`);
    }
    return artifact;
  });

const deterministicNodeOutput = (
  node: Exclude<WorkflowNode, AgentWorkflowNode>,
  dependencies: readonly ExecutionArtifactReference[],
  store: ExecutionJournalStore,
): PluginJsonValue => {
  if (node.type === 'join') {
    return {
      results: (node.dependsOn ?? []).map((nodeId, index) => ({
        nodeId,
        output: store.readJsonArtifact(dependencies[index] as ExecutionArtifactReference),
      })),
    };
  }
  if (node.type === 'gate') {
    return { condition: node.condition, passed: true };
  }
  return { approved: true, approvalSummary: node.approvalSummary };
};

const errorFromEvent = (event: ExecutionEvent | undefined): ExecutionRunError | undefined => {
  if (!event || event.type !== 'run.failed') {
    return undefined;
  }
  const payload = objectValue(event.payload, 'run.failed.payload');
  const nodeId = payload.nodeId;
  return {
    code: stringValue(payload, 'code', 'run.failed.payload') as ExecutionRunError['code'],
    message: stringValue(payload, 'message', 'run.failed.payload'),
    ...(typeof nodeId === 'string' ? { nodeId } : {}),
  };
};

const buildRunResult = (
  definition: WorkflowDefinition,
  plan: StaticExecutionPlan,
  store: ExecutionJournalStore,
  events: readonly ExecutionEvent[],
  status: ExecutionRunResult['status'],
): ExecutionRunResult => {
  const states = replayNodeStates(definition, events);
  const terminal = events.at(-1);
  const resultArtifact = terminal?.type === 'run.completed'
    ? artifactFromJson(
      objectValue(terminal.payload, 'run.completed.payload').resultArtifact,
      'run.completed.payload.resultArtifact',
    )
    : undefined;
  const failedNodeId = errorFromEvent(terminal)?.nodeId;
  const nodes: ExecutionRunNodeSummary[] = definition.nodes.map((node) => {
    const state = states.get(node.id) as NodeReplayState;
    return Object.freeze({
      attempts: state.maxStartedAttempt,
      id: node.id,
      status: state.completed ? 'completed' : failedNodeId === node.id ? 'failed' : 'pending',
      type: node.type,
      ...(state.artifact ? { artifact: state.artifact } : {}),
    });
  });
  const pausedPayload = status === 'paused'
    ? objectValue(terminal?.payload ?? {}, 'run.paused.payload')
    : undefined;
  const pausedNodeId = pausedPayload?.checkpointNodeId ?? pausedPayload?.nodeId;
  const pauseReason = pausedPayload?.reason;
  const error = status === 'paused'
    ? {
      code: pauseReason === 'checkpoint'
        ? 'checkpoint-required' as const
        : pauseReason === 'executor-blocked'
          ? 'executor-blocked' as const
          : 'paused' as const,
      message: pauseReason === 'checkpoint'
        ? 'Execution Run 等待 Checkpoint 批准'
        : pauseReason === 'executor-blocked'
          ? 'Execution Run 被 Executor 阻断'
          : 'Execution Run 已暂停',
      ...(typeof pausedNodeId === 'string' ? { nodeId: pausedNodeId } : {}),
    }
    : errorFromEvent(terminal);
  return Object.freeze({
    eventCount: events.length,
    nodes: Object.freeze(nodes),
    runId: store.runId,
    status,
    workflowHash: plan.workflowHash,
    workflowId: plan.workflowId,
    ...(error ? { error } : {}),
    ...(resultArtifact
      ? { resultArtifact, result: store.readJsonArtifact(resultArtifact) }
      : {}),
  });
};

const terminalStatus = (event: ExecutionEvent | undefined): ExecutionRunResult['status'] | undefined => {
  if (event?.type === 'run.completed') {
    return 'completed';
  }
  if (event?.type === 'run.cancelled') {
    return 'cancelled';
  }
  if (event?.type === 'run.failed') {
    return 'failed';
  }
  return undefined;
};

const emitRunFailure = (
  writer: EventWriter,
  definition: WorkflowDefinition,
  plan: StaticExecutionPlan,
  store: ExecutionJournalStore,
  error: ExecutionRunError,
): ExecutionRunResult => {
  writer.emit('run.failed', {
    code: error.code,
    message: error.message,
    ...(error.nodeId ? { nodeId: error.nodeId } : {}),
  });
  return buildRunResult(definition, plan, store, writer.events, 'failed');
};

export const runSerialWorkflow = async (
  options: SerialExecutionOptions,
): Promise<ExecutionRunResult> => {
  const plan = compileStaticExecutionPlan(options.definition);
  const definition = options.definition as WorkflowDefinition;
  const policyFindings = phaseOnePolicyFindings(definition);
  if (policyFindings.length > 0) {
    throw new Error(`Phase 1 执行策略拒绝：\n- ${policyFindings.join('\n- ')}`);
  }
  if (definition.inputSchema !== undefined) {
    const inputFindings = validateJsonValue(definition.inputSchema, options.input);
    if (inputFindings.length > 0) {
      throw new Error(`Workflow Input 无效：\n- ${inputFindings.join('\n- ')}`);
    }
  }
  const input = options.input as PluginJsonValue;
  const inputHash = hashPortableJson(input);
  const now = options.now ?? (() => new Date());
  const existingEvents = options.store.readEvents();
  validateEventIdentity(existingEvents, plan, options.store.runId);
  const mode = options.mode ?? 'start';
  if (mode === 'start' && existingEvents.length > 0) {
    throw new Error('Execution Run 已存在；请使用 resume');
  }
  if (mode === 'resume' && existingEvents.length === 0) {
    throw new Error('Execution Run 不存在，无法 resume');
  }

  const writer = new EventWriter(plan, options.store, now, existingEvents);
  let inputArtifact: ExecutionArtifactReference;
  if (mode === 'start') {
    const capabilities = await describeExecutor(options.executor);
    const compatibility = executorCompatibilityFindings(definition, capabilities);
    if (compatibility.errors.length > 0) {
      throw new Error(`Executor 不兼容：\n- ${compatibility.errors.join('\n- ')}`);
    }
    inputArtifact = options.store.writeJsonArtifact(input);
    writer.emit('run.created', {
      inputArtifact: artifactToJson(inputArtifact),
      inputHash,
    });
    writer.emit('run.started', {
      degradedCapabilities: compatibility.degraded,
      executorId: options.executor.id,
      mode: 'serial',
    });
  } else {
    const identity = runIdentityFromCreated(existingEvents[0] as ExecutionEvent);
    if (identity.inputHash !== inputHash) {
      throw new Error('Input hash 与现有 Run 不匹配，禁止复用');
    }
    inputArtifact = identity.inputArtifact;
    options.store.readJsonArtifact(inputArtifact);
    const status = terminalStatus(existingEvents.at(-1));
    if (status) {
      return buildRunResult(definition, plan, options.store, existingEvents, status);
    }
    const lastEvent = existingEvents.at(-1) as ExecutionEvent;
    const lastPayload = objectValue(lastEvent.payload, `${lastEvent.type}.payload`);
    const checkpointNodeId = lastEvent.type === 'run.paused' &&
      lastPayload.reason === 'checkpoint'
      ? lastPayload.checkpointNodeId
      : undefined;
    if (
      typeof checkpointNodeId === 'string' &&
      !(options.approvedCheckpoints ?? []).includes(checkpointNodeId)
    ) {
      return buildRunResult(definition, plan, options.store, existingEvents, 'paused');
    }
    const capabilities = await describeExecutor(options.executor);
    const compatibility = executorCompatibilityFindings(definition, capabilities);
    if (compatibility.errors.length > 0) {
      throw new Error(`Executor 不兼容：\n- ${compatibility.errors.join('\n- ')}`);
    }
    writer.emit('run.resumed', {
      ...(typeof checkpointNodeId === 'string' ? { approvedCheckpoint: checkpointNodeId } : {}),
      degradedCapabilities: compatibility.degraded,
      reason: typeof checkpointNodeId === 'string' ? 'checkpoint-approved' : 'recovery',
    });
  }

  const states = replayNodeStates(definition, writer.events);
  const approvedCheckpoints = new Set(options.approvedCheckpoints ?? []);
  for (const planNode of plan.nodes) {
    const node = definition.nodes.find(({ id }) => id === planNode.id) as WorkflowNode;
    const state = states.get(node.id) as NodeReplayState;
    if (state.completed) {
      if (state.artifact) {
        options.store.readJsonArtifact(state.artifact);
      }
      continue;
    }
    const attempt = nextAttempt(state);
    if (attempt > definition.limits.maxAttemptsPerNode) {
      return emitRunFailure(writer, definition, plan, options.store, {
        code: 'budget-exhausted',
        message: `节点 ${node.id} 已达到尝试次数上限`,
        nodeId: node.id,
      });
    }
    const dependencies = dependencyArtifacts(node, states);

    if (node.type === 'checkpoint' && !approvedCheckpoints.has(node.id)) {
      writer.emit('run.checkpointed', {
        approvalSummary: node.approvalSummary,
        checkpointNodeId: node.id,
      });
      writer.emit('run.paused', { checkpointNodeId: node.id, reason: 'checkpoint' });
      return buildRunResult(definition, plan, options.store, writer.events, 'paused');
    }

    if (activeDurationMs(writer.events, now()) >= definition.limits.maxDurationMs) {
      return emitRunFailure(writer, definition, plan, options.store, {
        code: 'budget-exhausted',
        message: 'Execution Run 已达到持续时间上限',
        nodeId: node.id,
      });
    }

    if (node.type !== 'agent') {
      writer.emit('node.scheduled', { mode: 'deterministic' }, { attempt, nodeId: node.id });
      writer.emit('node.started', {}, { attempt, nodeId: node.id });
      let output: PluginJsonValue;
      try {
        output = deterministicNodeOutput(node, dependencies, options.store);
        hashPortableJson(output, 1024 * 1024);
      } catch (error: unknown) {
        writer.emit('node.failed', {
          code: 'journal-corrupt',
          message: errorMessage(error),
          retryable: false,
        }, { attempt, nodeId: node.id });
        return emitRunFailure(writer, definition, plan, options.store, {
          code: 'journal-corrupt',
          message: `确定性节点 ${node.id} 无法生成或读取 Artifact`,
          nodeId: node.id,
        });
      }
      const artifact = options.store.writeJsonArtifact(output);
      writer.emit('node.output-validated', { artifact: artifactToJson(artifact) }, {
        attempt,
        nodeId: node.id,
      });
      writer.emit('node.completed', { artifact: artifactToJson(artifact) }, {
        attempt,
        nodeId: node.id,
      });
      state.artifact = artifact;
      state.completed = true;
      state.maxScheduledAttempt = attempt;
      state.maxStartedAttempt = attempt;
      continue;
    }

    let currentAttempt = attempt;
    while (currentAttempt <= definition.limits.maxAttemptsPerNode) {
      const nodeIdentity = { attempt: currentAttempt, nodeId: node.id };
      writer.emit('node.scheduled', { mode: 'executor' }, nodeIdentity);
      writer.emit('node.started', { executorId: options.executor.id }, nodeIdentity);
      state.maxScheduledAttempt = currentAttempt;
      state.maxStartedAttempt = currentAttempt;
      const remainingDuration = Math.max(
        1,
        definition.limits.maxDurationMs - activeDurationMs(writer.events, now()),
      );
      const request: AgentExecutionRequest = {
        apiVersion: AGENT_EXECUTOR_API_VERSION,
        attempt: currentAttempt,
        contextArtifacts: [inputArtifact.id, ...dependencies.map(({ id }) => id)],
        idempotencyKey: `${options.store.runId}:${node.id}:${currentAttempt}`,
        limits: {
          maxDurationMs: remainingDuration,
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
          maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
        },
        nodeId: node.id,
        permissions: [...(node.permissions ?? [])],
        preferredCapabilities: [...(node.preferredCapabilities ?? [])],
        prompt: node.prompt,
        requiredCapabilities: [...(node.requiredCapabilities ?? [])],
        runId: options.store.runId,
        workspace: {
          mode: node.workspace?.mode ?? 'shared-readonly',
          ...(node.workspace?.repository ? { repository: node.workspace.repository } : {}),
        },
        ...(node.outputSchema !== undefined ? { outputSchema: node.outputSchema } : {}),
      };

      let executorResult: AgentExecutionResult;
      try {
        executorResult = await executeWithTimeout(options.executor, request, remainingDuration);
      } catch (error: unknown) {
        const timeout = error instanceof ExecutionTimeoutError;
        executorResult = {
          apiVersion: AGENT_EXECUTOR_API_VERSION,
          artifacts: [],
          attempt: currentAttempt,
          error: {
            code: timeout ? 'timeout' : 'unknown',
            message: timeout ? 'Agent 执行超时' : errorMessage(error),
          },
          executor: { id: options.executor.id },
          findings: [],
          nodeId: node.id,
          retryable: !timeout,
          runId: options.store.runId,
          status: 'failed',
          usage: {
            durationMs: 0,
            inputTokens: null,
            outputTokens: null,
            toolCalls: null,
          },
        };
      }

      const structureFinding = resultStructureFinding(executorResult);
      let failure = structureFinding
        ? { code: 'invalid-output', message: structureFinding, retryable: false }
        : resultFailure(executorResult, request);
      const resultUsage = structureFinding
        ? { durationMs: 0, inputTokens: null, outputTokens: null, toolCalls: null }
        : executorResult.usage;

      if (!failure && executorResult.status === 'cancelled') {
        writer.emit('node.failed', { code: 'cancelled', message: 'Executor 已取消节点' }, nodeIdentity);
        writer.emit('run.cancelled', { nodeId: node.id, reason: 'executor-cancelled' });
        return buildRunResult(definition, plan, options.store, writer.events, 'cancelled');
      }
      if (!failure && executorResult.status === 'blocked') {
        writer.emit('node.failed', {
          code: executorResult.error?.code ?? 'unknown',
          message: executorResult.error?.message ?? 'Executor 阻断节点',
          status: 'blocked',
        }, nodeIdentity);
        writer.emit('run.paused', { nodeId: node.id, reason: 'executor-blocked' });
        return buildRunResult(definition, plan, options.store, writer.events, 'paused');
      }

      const output = structureFinding ? null : executorResult.output ?? null;
      if (!failure && executorResult.status === 'succeeded' && node.outputSchema !== undefined) {
        const outputFindings = validateJsonValue(
          node.outputSchema,
          output,
          DEFAULT_MAX_OUTPUT_BYTES,
        );
        if (outputFindings.length > 0) {
          failure = {
            code: 'invalid-output',
            message: `结构化输出无效：${outputFindings[0]}`,
            retryable: true,
          };
        }
      }
      if (!failure) {
        try {
          hashPortableJson(output, DEFAULT_MAX_OUTPUT_BYTES);
        } catch {
          failure = {
            code: 'invalid-output',
            message: 'Agent Output 超过字节上限或不是可移植 JSON',
            retryable: false,
          };
        }
      }

      if (!failure) {
        const artifact = options.store.writeJsonArtifact(output);
        writer.emit('node.output-validated', {
          artifact: artifactToJson(artifact),
          findings: executorResult.findings.map((finding) => ({
            code: finding.code,
            message: finding.message,
            severity: finding.severity,
            ...(finding.path ? { path: finding.path } : {}),
          })),
        }, nodeIdentity);
        writer.emit('node.completed', {
          artifact: artifactToJson(artifact),
          reportedArtifacts: [...executorResult.artifacts],
          usage: usageToJson(executorResult.usage),
        }, nodeIdentity);
        state.artifact = artifact;
        state.completed = true;
        break;
      }

      writer.emit('node.failed', {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        usage: usageToJson(resultUsage),
      }, nodeIdentity);
      const next = currentAttempt + 1;
      if (!failure.retryable || next > definition.limits.maxAttemptsPerNode) {
        return emitRunFailure(writer, definition, plan, options.store, {
          code: failure.code === 'budget-exhausted' ? 'budget-exhausted' : 'node-failed',
          message: failure.message,
          nodeId: node.id,
        });
      }
      writer.emit('node.retry-scheduled', { reason: failure.code }, {
        attempt: next,
        nodeId: node.id,
      });
      state.maxScheduledAttempt = next;
      currentAttempt = next;
    }
  }

  const resultState = states.get(definition.resultNode);
  if (!resultState?.artifact) {
    return emitRunFailure(writer, definition, plan, options.store, {
      code: 'journal-corrupt',
      message: 'resultNode 完成后缺少 Artifact',
      nodeId: definition.resultNode,
    });
  }
  writer.emit('run.completed', { resultArtifact: artifactToJson(resultState.artifact) });
  return buildRunResult(definition, plan, options.store, writer.events, 'completed');
};

const controlExecution = (
  store: ExecutionJournalStore,
  action: 'cancel' | 'pause',
  now: () => Date,
): ExecutionControlResult => {
  const events = store.readEvents();
  const first = events[0];
  if (!first) {
    throw new Error('Execution Run 不存在');
  }
  if (first.type !== 'run.created') {
    throw new Error('Journal 第一条事件必须是 run.created');
  }
  if (events.some((event) =>
    event.workflowHash !== first.workflowHash ||
    event.workflowId !== first.workflowId ||
    event.runId !== store.runId)) {
    throw new Error('Journal 事件身份不一致');
  }
  const terminalIndex = events.findIndex(({ type }) => TERMINAL_EVENT_TYPES.has(type));
  if (terminalIndex >= 0 && terminalIndex !== events.length - 1) {
    throw new Error('Journal 在终止事件之后仍包含事件');
  }
  const terminal = terminalStatus(events.at(-1));
  if (terminal) {
    return { eventCount: events.length, runId: store.runId, status: terminal };
  }
  if (action === 'pause' && events.at(-1)?.type === 'run.paused') {
    return { eventCount: events.length, runId: store.runId, status: 'paused' };
  }
  const plan: StaticExecutionPlan = {
    layers: [],
    limits: {
      maxAgents: 1,
      maxAttemptsPerNode: 1,
      maxConcurrency: 1,
      maxDurationMs: 1000,
      maxExternalWrites: 0,
      maxIterations: 1,
    },
    nodes: [],
    resultNode: '',
    schemaVersion: 1,
    workflowHash: first.workflowHash,
    workflowId: first.workflowId,
  };
  const writer = new EventWriter(plan, store, now, events);
  if (action === 'cancel') {
    writer.emit('run.cancelled', { reason: 'user-requested' });
    return { eventCount: writer.events.length, runId: store.runId, status: 'cancelled' };
  }
  writer.emit('run.paused', { reason: 'user-requested' });
  return { eventCount: writer.events.length, runId: store.runId, status: 'paused' };
};

/** Cooperative pause between serial invocations; it never interrupts another process. */
export const pauseSerialWorkflow = (
  store: ExecutionJournalStore,
  now: () => Date = () => new Date(),
): ExecutionControlResult => controlExecution(store, 'pause', now);

/** Appends a terminal cancellation event; active Executor cancellation remains host-owned. */
export const cancelSerialWorkflow = (
  store: ExecutionJournalStore,
  now: () => Date = () => new Date(),
): ExecutionControlResult => controlExecution(store, 'cancel', now);
