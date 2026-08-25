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
  type CheckpointWorkflowNode,
  type ExecutionArtifactReference,
  type ExecutionControlResult,
  type ExecutionEvent,
  type ExecutionEventType,
  type ExecutionJournalStore,
  type ExecutionRunError,
  type ExecutionRunNodeSummary,
  type ExecutionRunResult,
  type ExecutionRunUsageSummary,
  type GateWorkflowNode,
  type JoinWorkflowNode,
  type MapWorkflowNode,
  type ParallelWorkflowNode,
  type ReduceWorkflowNode,
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
import { negotiateExecutorCapabilities } from './capability-negotiation.js';
import { calculateExecutionEventHash } from './file-journal.js';

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_TOOL_CALLS = 50;
const EXECUTION_CONTROL_POLL_MS = 100;
const EXECUTOR_CANCEL_GRACE_MS = 1000;
const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const SAFE_READONLY_PERMISSIONS = new Set<PluginPermission>([
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

export interface ParallelExecutionOptions extends SerialExecutionOptions {
  readonly serialFallback?: 'allow' | 'reject';
}

export type PortableExecutionOptions = ParallelExecutionOptions;

interface NodeReplayState {
  artifact?: ExecutionArtifactReference;
  completed: boolean;
  error?: { code: string; message: string };
  failed: boolean;
  lanes: Map<string, LaneReplayState>;
  maxScheduledAttempt: number;
  maxStartedAttempt: number;
}

interface LaneReplayState {
  artifact?: ExecutionArtifactReference;
  completed: boolean;
  error?: { code: string; message: string };
  failed: boolean;
  maxScheduledAttempt: number;
  maxStartedAttempt: number;
}

interface ParallelAgentTask {
  readonly contextArtifacts: readonly ExecutionArtifactReference[];
  readonly key: string;
  readonly lane?: {
    readonly id: string;
    readonly index: number;
    readonly itemArtifact: ExecutionArtifactReference;
  };
  readonly node: AgentWorkflowNode | MapWorkflowNode;
  readonly state: NodeReplayState | LaneReplayState;
}

interface ScheduledParallelTask extends ParallelAgentTask {
  readonly attempt: number;
}

interface ParallelTaskFailure {
  readonly code: string;
  readonly message: string;
  readonly nodeId: string;
  readonly taskKey: string;
}

interface RunIdentity {
  inputArtifact: ExecutionArtifactReference;
  inputHash: string;
}

class ExecutionTimeoutError extends Error {}
class ExecutionInterruptedError extends Error {}
class ExecutionControlChangedError extends Error {
  readonly status: ExecutionRunResult['status'];

  constructor(status: ExecutionRunResult['status']) {
    super(`Execution 控制状态已变化：${status}`);
    this.status = status;
  }
}

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
    node?: { attempt: number; laneId?: string; nodeId: string },
  ): ExecutionEvent {
    const sequence = this.events.length;
    const timestamp = this.#now().toISOString();
    const previousEventHash = this.events.at(-1)?.eventHash ?? null;
    const eventIdSeed = serializeCanonicalJson({
      attempt: node?.attempt ?? null,
      laneId: node?.laneId ?? null,
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
      ...(node?.laneId ? { laneId: node.laneId } : {}),
    };
    const event: ExecutionEvent = Object.freeze({
      ...draft,
      eventHash: calculateExecutionEventHash(draft),
    });
    try {
      this.#store.append(event);
    } catch (error: unknown) {
      const added = this.refresh();
      const last = this.events.at(-1);
      const status = last?.type === 'run.paused' ? 'paused' : terminalStatus(last);
      if (added.length > 0 && status) {
        throw new ExecutionControlChangedError(status);
      }
      throw error;
    }
    this.events.push(event);
    return event;
  }

  refresh(): readonly ExecutionEvent[] {
    const persisted = this.#store.readEvents();
    const previousLength = this.events.length;
    if (persisted.length < this.events.length) {
      throw new Error('Journal 事件数量回退');
    }
    for (let index = 0; index < this.events.length; index += 1) {
      if (persisted[index]?.eventHash !== this.events[index]?.eventHash) {
        throw new Error('Journal 与当前进程事件前缀不一致');
      }
    }
    for (const event of persisted.slice(previousLength)) {
      if (
        event.runId !== this.#store.runId ||
        event.workflowHash !== this.#plan.workflowHash ||
        event.workflowId !== this.#plan.workflowId
      ) {
        throw new Error('Journal 新增事件身份不匹配');
      }
      this.events.push(event);
    }
    return persisted.slice(previousLength);
  }
}

const phaseOnePolicyFindings = (definition: WorkflowDefinition): string[] => {
  const findings: string[] = [];
  if (definition.limits.maxExternalWrites !== 0) {
    findings.push('Phase 1 要求 limits.maxExternalWrites 为 0');
  }
  for (const node of definition.nodes) {
    if (node.type === 'map' || node.type === 'parallel' || node.type === 'reduce') {
      findings.push(`节点 ${node.id}：Phase 1 不支持 ${node.type} 节点`);
      continue;
    }
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
      .filter((permission) => !SAFE_READONLY_PERMISSIONS.has(permission))
      .sort();
    if (unsafePermissions.length > 0) {
      findings.push(`节点 ${node.id}：Phase 1 不允许权限 ${unsafePermissions.join(', ')}`);
    }
  }
  return findings.sort();
};

const phaseTwoPolicyFindings = (definition: WorkflowDefinition): string[] => {
  const findings: string[] = [];
  if (definition.limits.maxExternalWrites !== 0) {
    findings.push('Phase 2 要求 limits.maxExternalWrites 为 0');
  }
  for (const node of definition.nodes) {
    if (node.type !== 'agent' && node.type !== 'map') {
      continue;
    }
    if (node.workspace?.mode === 'exclusive-worktree') {
      findings.push(`节点 ${node.id}：Phase 2 只允许共享只读 Workspace`);
    }
    if (node.workspace?.repository) {
      findings.push(`节点 ${node.id}：Phase 2 尚未开放 repository binding`);
    }
    const unsafePermissions = (node.permissions ?? [])
      .filter((permission) => !SAFE_READONLY_PERMISSIONS.has(permission))
      .sort();
    if (unsafePermissions.length > 0) {
      findings.push(`节点 ${node.id}：Phase 2 不允许权限 ${unsafePermissions.join(', ')}`);
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
      (record.laneId !== undefined && typeof record.laneId !== 'string') ||
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

const executorCompatibilityFindings = (
  definition: WorkflowDefinition,
  capabilities: AgentExecutorCapabilities,
): { errors: string[]; degraded: string[] } => {
  const negotiation = negotiateExecutorCapabilities(definition, capabilities);
  return {
    errors: [...negotiation.errors],
    degraded: negotiation.degradedCapabilities
      .filter((capability) => !capability.startsWith('executor-concurrency:')),
  };
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
    failed: false,
    lanes: new Map<string, LaneReplayState>(),
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
    let replayState: NodeReplayState | LaneReplayState = state;
    if (event.laneId) {
      let laneState = state.lanes.get(event.laneId);
      if (!laneState) {
        laneState = {
          completed: false,
          failed: false,
          maxScheduledAttempt: 0,
          maxStartedAttempt: 0,
        };
        state.lanes.set(event.laneId, laneState);
      }
      replayState = laneState;
    }
    if (event.type === 'node.scheduled' || event.type === 'node.retry-scheduled') {
      replayState.maxScheduledAttempt = Math.max(replayState.maxScheduledAttempt, event.attempt);
    }
    if (event.type === 'node.started') {
      replayState.maxStartedAttempt = Math.max(replayState.maxStartedAttempt, event.attempt);
    }
    if (event.type === 'node.completed') {
      replayState.completed = true;
      replayState.failed = false;
      replayState.artifact = artifactFromJson(
        objectValue(event.payload, 'node.completed.payload').artifact,
        'node.completed.payload.artifact',
      );
    }
    if (event.type === 'node.failed') {
      const payload = objectValue(event.payload, 'node.failed.payload');
      if (payload.terminal === true || payload.isolated === true) {
        replayState.failed = true;
        replayState.error = {
          code: stringValue(payload, 'code', 'node.failed.payload'),
          message: stringValue(payload, 'message', 'node.failed.payload'),
        };
      }
    }
  }
  return states;
};

const nextAttempt = (
  state: Pick<NodeReplayState, 'maxScheduledAttempt' | 'maxStartedAttempt'>,
): number => {
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
  signal?: AbortSignal,
): Promise<AgentExecutionResult> => {
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ExecutionTimeoutError('Agent 执行超时')), timeoutMs);
  });
  const interrupted = new Promise<never>((_resolve, reject) => {
    abortHandler = () => reject(new ExecutionInterruptedError('Execution 控制状态已变化'));
    if (signal?.aborted) {
      abortHandler();
    } else {
      signal?.addEventListener('abort', abortHandler, { once: true });
    }
  });
  try {
    return await Promise.race([executor.execute(request), timeout, interrupted]);
  } catch (error: unknown) {
    if (
      (error instanceof ExecutionTimeoutError || error instanceof ExecutionInterruptedError) &&
      executor.cancel
    ) {
      let cancelTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          executor.cancel({
            apiVersion: AGENT_EXECUTOR_API_VERSION,
            attempt: request.attempt,
            ...(request.lane ? { laneId: request.lane.id } : {}),
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
    if (abortHandler) {
      signal?.removeEventListener('abort', abortHandler);
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
    result.attempt !== request.attempt ||
    result.laneId !== request.lane?.id
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
  node: CheckpointWorkflowNode | GateWorkflowNode | JoinWorkflowNode,
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

class DeterministicNodeFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const decodePointerToken = (token: string): string => token
  .replaceAll('~1', '/')
  .replaceAll('~0', '~');

const resolveJsonPointer = (value: PluginJsonValue, pointer = ''): PluginJsonValue => {
  if (pointer === '') {
    return value;
  }
  let current: PluginJsonValue = value;
  for (const encodedToken of pointer.slice(1).split('/')) {
    const token = decodePointerToken(encodedToken);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) {
        throw new Error(`JSON Pointer 数组索引无效：${pointer}`);
      }
      const index = Number(token);
      if (index >= current.length) {
        throw new Error(`JSON Pointer 数组索引越界：${pointer}`);
      }
      current = current[index] as PluginJsonValue;
      continue;
    }
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      throw new Error(`JSON Pointer 不存在：${pointer}`);
    }
    current = current[token] as PluginJsonValue;
  }
  return current;
};

const completedStateOutput = (
  nodeId: string,
  state: NodeReplayState,
  store: ExecutionJournalStore,
): PluginJsonValue => {
  if (!state.completed || !state.artifact) {
    throw new DeterministicNodeFailure('dependency-failed', `依赖 ${nodeId} 未成功完成`);
  }
  return store.readJsonArtifact(state.artifact);
};

const parallelNodeOutput = (
  node: ParallelWorkflowNode,
  states: ReadonlyMap<string, NodeReplayState>,
  store: ExecutionJournalStore,
): PluginJsonValue => {
  const branches = node.dependsOn.map((nodeId) => {
    const state = states.get(nodeId);
    if (!state || (!state.completed && !state.failed)) {
      throw new Error(`Parallel 依赖 ${nodeId} 尚未结束`);
    }
    if (state.completed && state.artifact) {
      return {
        nodeId,
        output: store.readJsonArtifact(state.artifact),
        status: 'succeeded' as const,
      };
    }
    return {
      error: {
        code: state.error?.code ?? 'unknown',
        message: state.error?.message ?? '隔离分支失败',
      },
      nodeId,
      status: 'failed' as const,
    };
  });
  const succeeded = branches.filter(({ status }) => status === 'succeeded').length;
  const minSuccess = node.minSuccess ?? node.dependsOn.length;
  if (succeeded < minSuccess) {
    throw new DeterministicNodeFailure(
      'insufficient-success',
      `Parallel 节点 ${node.id} 仅 ${succeeded}/${node.dependsOn.length} 个分支成功，低于 ${minSuccess}`,
    );
  }
  return {
    branches,
    failed: branches.length - succeeded,
    minSuccess,
    mode: node.mode,
    succeeded,
  };
};

const reduceNodeOutput = (
  node: ReduceWorkflowNode,
  states: ReadonlyMap<string, NodeReplayState>,
  store: ExecutionJournalStore,
): PluginJsonValue => {
  const items: PluginJsonValue[] = [];
  for (const nodeId of node.dependsOn) {
    const state = states.get(nodeId);
    if (!state) {
      throw new Error(`Reduce 依赖不存在：${nodeId}`);
    }
    const output = completedStateOutput(nodeId, state, store);
    const selected = resolveJsonPointer(output, node.itemsPointer);
    if (node.itemsPointer !== undefined) {
      if (!Array.isArray(selected)) {
        throw new DeterministicNodeFailure(
          'invalid-reduction-input',
          `Reduce 节点 ${node.id} 的 itemsPointer 必须指向数组`,
        );
      }
      items.push(...selected);
    } else {
      items.push(selected);
    }
  }
  const reduced = node.strategy === 'dedupe'
    ? [...new Map(items.map((item) => [serializeCanonicalJson(item), item])).values()]
    : items;
  return { items: reduced, strategy: node.strategy };
};

const phaseTwoDeterministicNodeOutput = (
  node: CheckpointWorkflowNode | GateWorkflowNode | JoinWorkflowNode |
    ParallelWorkflowNode | ReduceWorkflowNode,
  states: ReadonlyMap<string, NodeReplayState>,
  store: ExecutionJournalStore,
): PluginJsonValue => {
  if (node.type === 'parallel') {
    return parallelNodeOutput(node, states, store);
  }
  if (node.type === 'reduce') {
    return reduceNodeOutput(node, states, store);
  }
  if (node.type === 'gate') {
    const dependencies = node.dependsOn.map((id) => states.get(id));
    const passed = node.condition === 'all-completed'
      ? dependencies.every((state) => state?.completed || state?.failed)
      : dependencies.every((state) => state?.completed);
    if (!passed) {
      throw new DeterministicNodeFailure(
        'gate-rejected',
        `Gate 节点 ${node.id} 条件 ${node.condition} 未通过`,
      );
    }
    return { condition: node.condition, passed: true };
  }
  const dependencies = dependencyArtifacts(node, states);
  return deterministicNodeOutput(node, dependencies, store);
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

interface MutableUsage {
  attempts: number;
  durationMs: number;
  executorCalls: number;
  failedCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number | null;
}

const emptyUsage = (): MutableUsage => ({
  attempts: 0,
  durationMs: 0,
  executorCalls: 0,
  failedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
});

const addNullableUsage = (current: number | null, value: unknown): number | null => {
  if (current === null || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error('Journal usage 必须是非负整数或 null');
  }
  return current + (value as number);
};

const addEventUsage = (target: MutableUsage, event: ExecutionEvent): boolean => {
  if (event.type !== 'node.completed' && event.type !== 'node.failed') {
    return false;
  }
  const payload = objectValue(event.payload, `${event.type}.payload`);
  if (payload.usage === undefined) {
    return false;
  }
  const usage = objectValue(payload.usage, `${event.type}.payload.usage`);
  if (!Number.isFinite(usage.durationMs) || (usage.durationMs as number) < 0) {
    throw new Error('Journal usage.durationMs 必须是非负数');
  }
  target.attempts += 1;
  target.executorCalls += 1;
  target.failedCalls += event.type === 'node.failed' ? 1 : 0;
  target.durationMs += usage.durationMs as number;
  target.inputTokens = addNullableUsage(target.inputTokens, usage.inputTokens);
  target.outputTokens = addNullableUsage(target.outputTokens, usage.outputTokens);
  target.toolCalls = addNullableUsage(target.toolCalls, usage.toolCalls);
  return true;
};

const buildUsageSummary = (
  definition: WorkflowDefinition,
  events: readonly ExecutionEvent[],
): ExecutionRunUsageSummary => {
  const total = emptyUsage();
  const byNode = new Map(definition.nodes.map(({ id }) => [id, emptyUsage()]));
  let maxConcurrencyObserved = 0;
  for (const event of events) {
    if (event.type === 'node.started') {
      const payload = objectValue(event.payload, 'node.started.payload');
      if (typeof payload.executorId === 'string') {
        const activeCount = payload.activeCount ?? 1;
        if (!Number.isInteger(activeCount) || (activeCount as number) < 1) {
          throw new Error('Journal node.started activeCount 无效');
        }
        maxConcurrencyObserved = Math.max(maxConcurrencyObserved, activeCount as number);
      }
    }
    if (!event.nodeId) {
      continue;
    }
    const nodeUsage = byNode.get(event.nodeId);
    if (!nodeUsage) {
      throw new Error(`Journal usage 引用了未知节点：${event.nodeId}`);
    }
    if (addEventUsage(nodeUsage, event)) {
      addEventUsage(total, event);
    }
  }
  const nodes = definition.nodes.map(({ id }) => Object.freeze({
    ...byNode.get(id) as MutableUsage,
    nodeId: id,
  }));
  return Object.freeze({
    ...total,
    maxConcurrencyObserved,
    nodes: Object.freeze(nodes),
  });
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
    const laneAttempts = [...state.lanes.values()]
      .reduce((total, lane) => total + lane.maxStartedAttempt, 0);
    return Object.freeze({
      attempts: laneAttempts || state.maxStartedAttempt,
      id: node.id,
      status: state.completed
        ? 'completed'
        : state.failed || failedNodeId === node.id ? 'failed' : 'pending',
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
    usage: buildUsageSummary(definition, events),
    workflowHash: plan.workflowHash,
    workflowId: plan.workflowId,
    ...(error ? { error } : {}),
    ...(resultArtifact
      ? { resultArtifact, result: store.readJsonArtifact(resultArtifact) }
      : {}),
  });
};

const buildControlledRunResult = (
  options: SerialExecutionOptions,
  status: ExecutionRunResult['status'],
): ExecutionRunResult => {
  const plan = compileStaticExecutionPlan(options.definition);
  const definition = options.definition as WorkflowDefinition;
  const events = options.store.readEvents();
  validateEventIdentity(events, plan, options.store.runId);
  return buildRunResult(definition, plan, options.store, events, status);
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

const runSerialWorkflowInternal = async (
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
      if (node.type === 'map' || node.type === 'parallel' || node.type === 'reduce') {
        throw new Error(`Phase 1 不支持 ${node.type} 节点`);
      }
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

export const runSerialWorkflow = async (
  options: SerialExecutionOptions,
): Promise<ExecutionRunResult> => {
  try {
    return await runSerialWorkflowInternal(options);
  } catch (error: unknown) {
    if (!(error instanceof ExecutionControlChangedError)) {
      throw error;
    }
    return buildControlledRunResult(options, error.status);
  }
};

const parallelNodeIdentity = (
  task: ParallelAgentTask,
  attempt: number,
): { attempt: number; laneId?: string; nodeId: string } => ({
  attempt,
  nodeId: task.node.id,
  ...(task.lane ? { laneId: task.lane.id } : {}),
});

const journalControlStatus = (
  writer: EventWriter,
): ExecutionRunResult['status'] | undefined => {
  const added = writer.refresh();
  const last = writer.events.at(-1);
  if (
    added.length > 0 &&
    last?.type !== 'run.paused' &&
    !TERMINAL_EVENT_TYPES.has(last?.type as ExecutionEventType)
  ) {
    throw new Error('Journal 检测到另一个 Runner 的并发非控制写入');
  }
  if (last?.type === 'run.paused') {
    return 'paused';
  }
  return terminalStatus(last);
};

const waitForWave = async (
  writer: EventWriter,
  controller: AbortController,
  executions: Promise<AgentExecutionResult>[],
): Promise<{ control?: ExecutionRunResult['status']; results: AgentExecutionResult[] }> => {
  let settled = false;
  const all = Promise.all(executions).then((results) => {
    settled = true;
    return results;
  });
  while (!settled) {
    let pollTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        pollTimer = setTimeout(resolve, EXECUTION_CONTROL_POLL_MS);
      }),
    ]);
    if (pollTimer) {
      clearTimeout(pollTimer);
    }
    if (settled) {
      break;
    }
    let control: ExecutionRunResult['status'] | undefined;
    try {
      control = journalControlStatus(writer);
    } catch (error: unknown) {
      controller.abort();
      await all;
      throw error;
    }
    if (control) {
      controller.abort();
      return { control, results: await all };
    }
  }
  const results = await all;
  const control = journalControlStatus(writer);
  return { ...(control ? { control } : {}), results };
};

const executorFailureResult = (
  executor: AgentExecutorService,
  request: AgentExecutionRequest,
  error: unknown,
): AgentExecutionResult => {
  const timeout = error instanceof ExecutionTimeoutError;
  return {
    apiVersion: AGENT_EXECUTOR_API_VERSION,
    artifacts: [],
    attempt: request.attempt,
    error: {
      code: timeout ? 'timeout' : 'unknown',
      message: timeout ? 'Agent 执行超时' : errorMessage(error),
    },
    executor: { id: executor.id },
    findings: [],
    ...(request.lane ? { laneId: request.lane.id } : {}),
    nodeId: request.nodeId,
    retryable: !timeout,
    runId: request.runId,
    status: 'failed',
    usage: {
      durationMs: 0,
      inputTokens: null,
      outputTokens: null,
      toolCalls: null,
    },
  };
};

const buildParallelRequest = (
  task: ScheduledParallelTask,
  inputArtifact: ExecutionArtifactReference,
  runId: string,
  remainingDuration: number,
): AgentExecutionRequest => ({
  apiVersion: AGENT_EXECUTOR_API_VERSION,
  attempt: task.attempt,
  contextArtifacts: [
    inputArtifact.id,
    ...task.contextArtifacts.map(({ id }) => id),
    ...(task.lane ? [task.lane.itemArtifact.id] : []),
  ],
  idempotencyKey: [runId, task.node.id, task.lane?.id, task.attempt]
    .filter((part) => part !== undefined)
    .join(':'),
  limits: {
    maxDurationMs: remainingDuration,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  },
  ...(task.lane ? {
    lane: {
      id: task.lane.id,
      index: task.lane.index,
      itemArtifact: task.lane.itemArtifact.id,
    },
  } : {}),
  nodeId: task.node.id,
  permissions: [...(task.node.permissions ?? [])],
  preferredCapabilities: [...(task.node.preferredCapabilities ?? [])],
  prompt: task.node.prompt,
  requiredCapabilities: [...(task.node.requiredCapabilities ?? [])],
  runId,
  workspace: {
    mode: task.node.workspace?.mode ?? 'shared-readonly',
    ...(task.node.workspace?.repository
      ? { repository: task.node.workspace.repository }
      : {}),
  },
  ...(task.node.outputSchema !== undefined ? { outputSchema: task.node.outputSchema } : {}),
});

const executeParallelTasks = async (
  tasks: readonly ParallelAgentTask[],
  effectiveConcurrency: number,
  inputArtifact: ExecutionArtifactReference,
  definition: WorkflowDefinition,
  plan: StaticExecutionPlan,
  options: ParallelExecutionOptions,
  writer: EventWriter,
  now: () => Date,
): Promise<ExecutionRunResult | undefined> => {
  const queue: ScheduledParallelTask[] = tasks
    .map((task) => ({ ...task, attempt: nextAttempt(task.state) }))
    .sort((left, right) => compareStrings(left.key, right.key));

  while (queue.length > 0) {
    const control = journalControlStatus(writer);
    if (control) {
      return buildRunResult(definition, plan, options.store, writer.events, control);
    }
    if (activeDurationMs(writer.events, now()) >= definition.limits.maxDurationMs) {
      return emitRunFailure(writer, definition, plan, options.store, {
        code: 'budget-exhausted',
        message: 'Execution Run 已达到持续时间上限',
        ...(queue[0] ? { nodeId: queue[0].node.id } : {}),
      });
    }

    const wave = queue.splice(0, effectiveConcurrency);
    const overAttempt = wave.filter(({ attempt }) =>
      attempt > definition.limits.maxAttemptsPerNode);
    if (overAttempt.length > 0) {
      const first = overAttempt.sort((left, right) => compareStrings(left.key, right.key))[0];
      if (!first) {
        throw new Error('并行 attempt 状态无效');
      }
      return emitRunFailure(writer, definition, plan, options.store, {
        code: 'budget-exhausted',
        message: `节点 ${first.node.id} 已达到尝试次数上限`,
        nodeId: first.node.id,
      });
    }

    const remainingDuration = Math.max(
      1,
      definition.limits.maxDurationMs - activeDurationMs(writer.events, now()),
    );
    for (const task of wave) {
      const identity = parallelNodeIdentity(task, task.attempt);
      writer.emit('node.scheduled', { mode: 'executor-parallel' }, identity);
      writer.emit('node.started', {
        activeCount: wave.length,
        executorId: options.executor.id,
      }, identity);
      task.state.maxScheduledAttempt = task.attempt;
      task.state.maxStartedAttempt = task.attempt;
    }

    const controller = new AbortController();
    const requests = wave.map((task) => buildParallelRequest(
      task,
      inputArtifact,
      options.store.runId,
      remainingDuration,
    ));
    const executions = requests.map(async (request) => {
      try {
        return await executeWithTimeout(
          options.executor,
          request,
          remainingDuration,
          controller.signal,
        );
      } catch (error: unknown) {
        return executorFailureResult(options.executor, request, error);
      }
    });
    const waveResult = await waitForWave(writer, controller, executions);
    if (waveResult.control) {
      return buildRunResult(
        definition,
        plan,
        options.store,
        writer.events,
        waveResult.control,
      );
    }

    const retries: ScheduledParallelTask[] = [];
    const fatalFailures: ParallelTaskFailure[] = [];
    let blockedTask: ParallelTaskFailure | undefined;
    let cancelledTask: ParallelTaskFailure | undefined;

    for (let index = 0; index < wave.length; index += 1) {
      const task = wave[index] as ScheduledParallelTask;
      const request = requests[index] as AgentExecutionRequest;
      const executorResult = waveResult.results[index] as AgentExecutionResult;
      const identity = parallelNodeIdentity(task, task.attempt);
      const structureFinding = resultStructureFinding(executorResult);
      let failure = structureFinding
        ? { code: 'invalid-output', message: structureFinding, retryable: false }
        : resultFailure(executorResult, request);
      const resultUsage = structureFinding
        ? { durationMs: 0, inputTokens: null, outputTokens: null, toolCalls: null }
        : executorResult.usage;

      if (!failure && executorResult.status === 'cancelled') {
        writer.emit('node.failed', {
          code: 'cancelled',
          message: 'Executor 已取消节点',
          retryable: false,
          terminal: true,
          usage: usageToJson(resultUsage),
        }, identity);
        cancelledTask ??= {
          code: 'cancelled',
          message: 'Executor 已取消节点',
          nodeId: task.node.id,
          taskKey: task.key,
        };
        continue;
      }
      if (!failure && executorResult.status === 'blocked') {
        writer.emit('node.failed', {
          code: executorResult.error?.code ?? 'unknown',
          message: executorResult.error?.message ?? 'Executor 阻断节点',
          retryable: false,
          status: 'blocked',
          usage: usageToJson(resultUsage),
        }, identity);
        blockedTask ??= {
          code: executorResult.error?.code ?? 'unknown',
          message: executorResult.error?.message ?? 'Executor 阻断节点',
          nodeId: task.node.id,
          taskKey: task.key,
        };
        continue;
      }

      const output = structureFinding ? null : executorResult.output ?? null;
      if (!failure && executorResult.status === 'succeeded' && task.node.outputSchema !== undefined) {
        const outputFindings = validateJsonValue(
          task.node.outputSchema,
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
        }, identity);
        writer.emit('node.completed', {
          artifact: artifactToJson(artifact),
          reportedArtifacts: [...executorResult.artifacts],
          usage: usageToJson(executorResult.usage),
        }, identity);
        task.state.artifact = artifact;
        task.state.completed = true;
        task.state.failed = false;
        continue;
      }

      const next = task.attempt + 1;
      const terminal = !failure.retryable || next > definition.limits.maxAttemptsPerNode;
      const isolated = terminal && task.node.failurePolicy === 'isolate';
      writer.emit('node.failed', {
        code: failure.code,
        isolated,
        message: failure.message,
        retryable: failure.retryable,
        terminal,
        usage: usageToJson(resultUsage),
      }, identity);
      if (!terminal) {
        writer.emit('node.retry-scheduled', { reason: failure.code }, {
          ...identity,
          attempt: next,
        });
        task.state.maxScheduledAttempt = next;
        retries.push({ ...task, attempt: next });
        continue;
      }

      task.state.failed = true;
      task.state.error = { code: failure.code, message: failure.message };
      if (!isolated) {
        fatalFailures.push({
          code: failure.code,
          message: failure.message,
          nodeId: task.node.id,
          taskKey: task.key,
        });
      }
    }

    if (cancelledTask) {
      writer.emit('run.cancelled', {
        nodeId: cancelledTask.nodeId,
        reason: 'executor-cancelled',
      });
      return buildRunResult(definition, plan, options.store, writer.events, 'cancelled');
    }
    if (blockedTask) {
      writer.emit('run.paused', {
        nodeId: blockedTask.nodeId,
        reason: 'executor-blocked',
      });
      return buildRunResult(definition, plan, options.store, writer.events, 'paused');
    }
    if (fatalFailures.length > 0) {
      const failure = fatalFailures.sort((left, right) =>
        compareStrings(left.taskKey, right.taskKey))[0] as ParallelTaskFailure;
      return emitRunFailure(writer, definition, plan, options.store, {
        code: failure.code === 'budget-exhausted' ? 'budget-exhausted' : 'node-failed',
        message: failure.message,
        nodeId: failure.nodeId,
      });
    }
    queue.push(...retries);
  }
  return undefined;
};

const executePhaseTwoDeterministicNode = (
  node: CheckpointWorkflowNode | GateWorkflowNode | JoinWorkflowNode |
    ParallelWorkflowNode | ReduceWorkflowNode,
  state: NodeReplayState,
  approvedCheckpoints: ReadonlySet<string>,
  definition: WorkflowDefinition,
  plan: StaticExecutionPlan,
  store: ExecutionJournalStore,
  states: ReadonlyMap<string, NodeReplayState>,
  writer: EventWriter,
): ExecutionRunResult | undefined => {
  if (state.completed) {
    if (state.artifact) {
      store.readJsonArtifact(state.artifact);
    }
    return undefined;
  }
  const attempt = nextAttempt(state);
  if (attempt > definition.limits.maxAttemptsPerNode) {
    return emitRunFailure(writer, definition, plan, store, {
      code: 'budget-exhausted',
      message: `节点 ${node.id} 已达到尝试次数上限`,
      nodeId: node.id,
    });
  }
  if (node.type === 'checkpoint' && !approvedCheckpoints.has(node.id)) {
    writer.emit('run.checkpointed', {
      approvalSummary: node.approvalSummary,
      checkpointNodeId: node.id,
    });
    writer.emit('run.paused', { checkpointNodeId: node.id, reason: 'checkpoint' });
    return buildRunResult(definition, plan, store, writer.events, 'paused');
  }

  const identity = { attempt, nodeId: node.id };
  writer.emit('node.scheduled', { mode: 'deterministic' }, identity);
  writer.emit('node.started', {}, identity);
  state.maxScheduledAttempt = attempt;
  state.maxStartedAttempt = attempt;
  let output: PluginJsonValue;
  try {
    output = phaseTwoDeterministicNodeOutput(node, states, store);
    hashPortableJson(output, 1024 * 1024);
  } catch (error: unknown) {
    const code = error instanceof DeterministicNodeFailure ? error.code : 'journal-corrupt';
    writer.emit('node.failed', {
      code,
      message: errorMessage(error),
      retryable: false,
      terminal: true,
    }, identity);
    state.failed = true;
    state.error = { code, message: errorMessage(error) };
    return emitRunFailure(writer, definition, plan, store, {
      code: code === 'journal-corrupt' ? 'journal-corrupt' : 'node-failed',
      message: errorMessage(error),
      nodeId: node.id,
    });
  }
  const artifact = store.writeJsonArtifact(output);
  writer.emit('node.output-validated', { artifact: artifactToJson(artifact) }, identity);
  writer.emit('node.completed', { artifact: artifactToJson(artifact) }, identity);
  state.artifact = artifact;
  state.completed = true;
  state.failed = false;
  return undefined;
};

const finalizeMapNode = (
  node: MapWorkflowNode,
  itemCount: number,
  state: NodeReplayState,
  definition: WorkflowDefinition,
  plan: StaticExecutionPlan,
  store: ExecutionJournalStore,
  writer: EventWriter,
): ExecutionRunResult | undefined => {
  if (state.completed) {
    if (state.artifact) {
      store.readJsonArtifact(state.artifact);
    }
    return undefined;
  }
  const items: PluginJsonValue[] = [];
  const lanes: PluginJsonValue[] = [];
  for (let index = 0; index < itemCount; index += 1) {
    const laneId = `item-${String(index + 1).padStart(6, '0')}`;
    const lane = state.lanes.get(laneId);
    if (!lane || (!lane.completed && !lane.failed)) {
      throw new Error(`Map 节点 ${node.id} 的 lane ${laneId} 尚未结束`);
    }
    if (lane.completed && lane.artifact) {
      const output = store.readJsonArtifact(lane.artifact);
      items.push(output);
      lanes.push({ index, laneId, status: 'succeeded' });
    } else {
      lanes.push({
        error: {
          code: lane.error?.code ?? 'unknown',
          message: lane.error?.message ?? 'Map lane 失败',
        },
        index,
        laneId,
        status: 'failed',
      });
    }
  }
  const output: PluginJsonValue = {
    failed: lanes.filter((lane) =>
      typeof lane === 'object' && lane !== null && !Array.isArray(lane) && lane.status === 'failed').length,
    items,
    lanes,
    succeeded: items.length,
  };
  const attempt = state.maxStartedAttempt;
  if (attempt < 1) {
    throw new Error(`Map 节点 ${node.id} 尚未开始`);
  }
  const identity = { attempt, nodeId: node.id };
  let artifact: ExecutionArtifactReference;
  try {
    hashPortableJson(output, 1024 * 1024);
    artifact = store.writeJsonArtifact(output);
  } catch (error: unknown) {
    writer.emit('node.failed', {
      code: 'invalid-output',
      message: errorMessage(error),
      retryable: false,
      terminal: true,
    }, identity);
    return emitRunFailure(writer, definition, plan, store, {
      code: 'node-failed',
      message: `Map 节点 ${node.id} 无法生成汇总 Artifact`,
      nodeId: node.id,
    });
  }
  writer.emit('node.output-validated', { artifact: artifactToJson(artifact) }, identity);
  writer.emit('node.completed', { artifact: artifactToJson(artifact) }, identity);
  state.artifact = artifact;
  state.completed = true;
  state.failed = false;
  return undefined;
};

const runParallelWorkflowInternal = async (
  options: ParallelExecutionOptions,
): Promise<ExecutionRunResult> => {
  const plan = compileStaticExecutionPlan(options.definition);
  const definition = options.definition as WorkflowDefinition;
  const policyFindings = phaseTwoPolicyFindings(definition);
  if (policyFindings.length > 0) {
    throw new Error(`Phase 2 执行策略拒绝：\n- ${policyFindings.join('\n- ')}`);
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
  let effectiveConcurrency: number;
  if (mode === 'start') {
    const capabilities = await describeExecutor(options.executor);
    const negotiation = negotiateExecutorCapabilities(definition, capabilities);
    if (negotiation.errors.length > 0) {
      throw new Error(`Executor 不兼容：\n- ${negotiation.errors.join('\n- ')}`);
    }
    if (negotiation.mode === 'serial-fallback' && options.serialFallback === 'reject') {
      throw new Error(
        `Executor 只能提供串行能力：requested=${negotiation.requestedConcurrency}, ` +
        `effective=${negotiation.effectiveConcurrency}`,
      );
    }
    effectiveConcurrency = negotiation.effectiveConcurrency;
    inputArtifact = options.store.writeJsonArtifact(input);
    writer.emit('run.created', {
      inputArtifact: artifactToJson(inputArtifact),
      inputHash,
    });
    writer.emit('run.started', {
      degradedCapabilities: [
        ...negotiation.degradedCapabilities,
      ],
      effectiveConcurrency,
      executorMode: negotiation.mode,
      executorId: options.executor.id,
      mode: 'parallel-readonly',
      requestedConcurrency: definition.limits.maxConcurrency,
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
    const negotiation = negotiateExecutorCapabilities(definition, capabilities);
    if (negotiation.errors.length > 0) {
      throw new Error(`Executor 不兼容：\n- ${negotiation.errors.join('\n- ')}`);
    }
    if (negotiation.mode === 'serial-fallback' && options.serialFallback === 'reject') {
      throw new Error(
        `Executor 只能提供串行能力：requested=${negotiation.requestedConcurrency}, ` +
        `effective=${negotiation.effectiveConcurrency}`,
      );
    }
    effectiveConcurrency = negotiation.effectiveConcurrency;
    writer.emit('run.resumed', {
      ...(typeof checkpointNodeId === 'string' ? { approvedCheckpoint: checkpointNodeId } : {}),
      degradedCapabilities: [
        ...negotiation.degradedCapabilities,
      ],
      effectiveConcurrency,
      executorMode: negotiation.mode,
      reason: typeof checkpointNodeId === 'string' ? 'checkpoint-approved' : 'recovery',
    });
  }

  const states = replayNodeStates(definition, writer.events);
  const approvedCheckpoints = new Set(options.approvedCheckpoints ?? []);
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));

  for (const layerIds of plan.layers) {
    const layerNodes = layerIds.map((id) => nodesById.get(id) as WorkflowNode);
    const control = journalControlStatus(writer);
    if (control) {
      return buildRunResult(definition, plan, options.store, writer.events, control);
    }

    for (const node of layerNodes) {
      if (node.type === 'agent' || node.type === 'map') {
        continue;
      }
      if (activeDurationMs(writer.events, now()) >= definition.limits.maxDurationMs) {
        return emitRunFailure(writer, definition, plan, options.store, {
          code: 'budget-exhausted',
          message: 'Execution Run 已达到持续时间上限',
          nodeId: node.id,
        });
      }
      const result = executePhaseTwoDeterministicNode(
        node,
        states.get(node.id) as NodeReplayState,
        approvedCheckpoints,
        definition,
        plan,
        options.store,
        states,
        writer,
      );
      if (result) {
        return result;
      }
    }

    const tasks: ParallelAgentTask[] = [];
    const mapItemCounts = new Map<string, number>();
    for (const node of layerNodes) {
      if (node.type !== 'agent' && node.type !== 'map') {
        continue;
      }
      const state = states.get(node.id) as NodeReplayState;
      if (state.completed) {
        if (state.artifact) {
          options.store.readJsonArtifact(state.artifact);
        }
        continue;
      }
      if (state.failed) {
        if (node.failurePolicy === 'isolate') {
          continue;
        }
        return emitRunFailure(writer, definition, plan, options.store, {
          code: 'node-failed',
          message: state.error?.message ?? `节点 ${node.id} 已失败`,
          nodeId: node.id,
        });
      }
      if (node.type === 'map') {
        const parentAttempt = nextAttempt(state);
        if (parentAttempt > definition.limits.maxAttemptsPerNode) {
          return emitRunFailure(writer, definition, plan, options.store, {
            code: 'budget-exhausted',
            message: `Map 节点 ${node.id} 已达到尝试次数上限`,
            nodeId: node.id,
          });
        }
        writer.emit('node.scheduled', { mode: 'map' }, {
          attempt: parentAttempt,
          nodeId: node.id,
        });
        writer.emit('node.started', {}, { attempt: parentAttempt, nodeId: node.id });
        state.maxScheduledAttempt = parentAttempt;
        state.maxStartedAttempt = parentAttempt;
      }
      let dependencies: ExecutionArtifactReference[];
      try {
        dependencies = dependencyArtifacts(node, states);
      } catch (error: unknown) {
        if (node.type === 'map') {
          writer.emit('node.failed', {
            code: 'dependency-failed',
            message: errorMessage(error),
            retryable: false,
            terminal: true,
          }, { attempt: state.maxStartedAttempt, nodeId: node.id });
          state.failed = true;
          state.error = { code: 'dependency-failed', message: errorMessage(error) };
        }
        return emitRunFailure(writer, definition, plan, options.store, {
          code: 'node-failed',
          message: errorMessage(error),
          nodeId: node.id,
        });
      }
      if (node.type === 'agent') {
        tasks.push({
          contextArtifacts: dependencies,
          key: node.id,
          node,
          state,
        });
        continue;
      }

      let items: readonly PluginJsonValue[];
      try {
        const source = options.store.readJsonArtifact(
          dependencies[0] as ExecutionArtifactReference,
        );
        const selected = resolveJsonPointer(source, node.itemsPointer);
        if (!Array.isArray(selected)) {
          throw new Error(`Map 节点 ${node.id} 的 itemsPointer 必须指向数组`);
        }
        if (selected.length > node.maxItems) {
          throw new Error(
            `Map 节点 ${node.id} 展开 ${selected.length} 项，超过 maxItems ${node.maxItems}`,
          );
        }
        items = selected;
      } catch (error: unknown) {
        writer.emit('node.failed', {
          code: 'invalid-map-input',
          message: errorMessage(error),
          retryable: false,
          terminal: true,
        }, { attempt: state.maxStartedAttempt, nodeId: node.id });
        state.failed = true;
        state.error = { code: 'invalid-map-input', message: errorMessage(error) };
        return emitRunFailure(writer, definition, plan, options.store, {
          code: 'node-failed',
          message: errorMessage(error),
          nodeId: node.id,
        });
      }
      mapItemCounts.set(node.id, items.length);
      const expectedLaneIds = new Set(items.map((_item, index) =>
        `item-${String(index + 1).padStart(6, '0')}`));
      const unknownLane = [...state.lanes.keys()].find((laneId) => !expectedLaneIds.has(laneId));
      if (unknownLane) {
        return emitRunFailure(writer, definition, plan, options.store, {
          code: 'journal-corrupt',
          message: `Map 节点 ${node.id} 包含与当前输入不匹配的 lane：${unknownLane}`,
          nodeId: node.id,
        });
      }
      items.forEach((item, index) => {
        const laneId = `item-${String(index + 1).padStart(6, '0')}`;
        let laneState = state.lanes.get(laneId);
        if (!laneState) {
          laneState = {
            completed: false,
            failed: false,
            maxScheduledAttempt: 0,
            maxStartedAttempt: 0,
          };
          state.lanes.set(laneId, laneState);
        }
        if (laneState.completed) {
          if (laneState.artifact) {
            options.store.readJsonArtifact(laneState.artifact);
          }
          return;
        }
        if (laneState.failed) {
          return;
        }
        tasks.push({
          contextArtifacts: dependencies,
          key: `${node.id}/${laneId}`,
          lane: {
            id: laneId,
            index,
            itemArtifact: options.store.writeJsonArtifact(item),
          },
          node,
          state: laneState,
        });
      });
    }

    const taskResult = await executeParallelTasks(
      tasks,
      effectiveConcurrency,
      inputArtifact,
      definition,
      plan,
      options,
      writer,
      now,
    );
    if (taskResult) {
      return taskResult;
    }

    for (const node of layerNodes) {
      if (node.type !== 'map') {
        continue;
      }
      const state = states.get(node.id) as NodeReplayState;
      const failedLane = [...state.lanes.values()].find((lane) => lane.failed);
      if (failedLane && node.failurePolicy !== 'isolate') {
        return emitRunFailure(writer, definition, plan, options.store, {
          code: 'node-failed',
          message: failedLane.error?.message ?? `Map 节点 ${node.id} 的 lane 失败`,
          nodeId: node.id,
        });
      }
      const result = finalizeMapNode(
        node,
        mapItemCounts.get(node.id) ?? 0,
        state,
        definition,
        plan,
        options.store,
        writer,
      );
      if (result) {
        return result;
      }
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

/** Executes Phase 2 workflows with deterministic, read-only and bounded parallel waves. */
export const runParallelWorkflow = async (
  options: ParallelExecutionOptions,
): Promise<ExecutionRunResult> => {
  try {
    return await runParallelWorkflowInternal(options);
  } catch (error: unknown) {
    if (!(error instanceof ExecutionControlChangedError)) {
      throw error;
    }
    return buildControlledRunResult(options, error.status);
  }
};

/** Portable Phase 3 entrypoint; defaults to deterministic serial fallback. */
export const runPortableWorkflow = async (
  options: PortableExecutionOptions,
): Promise<ExecutionRunResult> => await runParallelWorkflow(options);

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
