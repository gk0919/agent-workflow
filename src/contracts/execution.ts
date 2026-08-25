import type {
  NamedPluginService,
  ValidationFinding,
} from './capabilities.js';
import type { PluginJsonObject, PluginJsonValue } from './json.js';
import type { PluginPermission } from './plugin.js';

export const WORKFLOW_DEFINITION_SCHEMA_VERSION = 1 as const;
export const EXECUTION_EVENT_SCHEMA_VERSION = 1 as const;
export const AGENT_EXECUTOR_API_VERSION = 1 as const;

export const WORKFLOW_NODE_TYPES = [
  'agent',
  'checkpoint',
  'gate',
  'join',
] as const;
export type WorkflowNodeType = typeof WORKFLOW_NODE_TYPES[number];

export const EXECUTION_EVENT_TYPES = [
  'run.created',
  'run.started',
  'node.scheduled',
  'node.started',
  'node.output-validated',
  'node.completed',
  'node.failed',
  'node.retry-scheduled',
  'run.checkpointed',
  'run.paused',
  'run.resumed',
  'run.cancelled',
  'run.completed',
] as const;
export type ExecutionEventType = typeof EXECUTION_EVENT_TYPES[number];

/** JSON Schema remains a portable JSON value; semantic validity is checked at runtime. */
export type PortableJsonSchema = boolean | Readonly<PluginJsonObject>;

export interface WorkflowExecutionLimits {
  readonly maxAgents: number;
  readonly maxAttemptsPerNode: number;
  readonly maxConcurrency: number;
  readonly maxDurationMs: number;
  readonly maxExternalWrites: number;
  readonly maxIterations: number;
}

export interface WorkflowNodeBase {
  readonly dependsOn?: readonly string[];
  readonly id: string;
  readonly label?: string;
  readonly type: WorkflowNodeType;
}

export type WorkspaceMode = 'exclusive-worktree' | 'shared-readonly';

export interface WorkflowWorkspaceRequirement {
  readonly mode: WorkspaceMode;
  readonly repository?: string;
}

export interface AgentWorkflowNode extends WorkflowNodeBase {
  readonly outputSchema?: PortableJsonSchema;
  readonly permissions?: readonly PluginPermission[];
  readonly preferredCapabilities?: readonly string[];
  readonly prompt: string;
  readonly requiredCapabilities?: readonly string[];
  readonly type: 'agent';
  readonly workspace?: WorkflowWorkspaceRequirement;
}

export interface JoinWorkflowNode extends WorkflowNodeBase {
  readonly dependsOn: readonly string[];
  readonly type: 'join';
}

export type WorkflowGateCondition = 'all-completed' | 'all-succeeded';

export interface GateWorkflowNode extends WorkflowNodeBase {
  readonly condition: WorkflowGateCondition;
  readonly dependsOn: readonly string[];
  readonly type: 'gate';
}

export interface CheckpointWorkflowNode extends WorkflowNodeBase {
  readonly approvalSummary: string;
  readonly dependsOn: readonly string[];
  readonly type: 'checkpoint';
}

export type WorkflowNode =
  | AgentWorkflowNode
  | CheckpointWorkflowNode
  | GateWorkflowNode
  | JoinWorkflowNode;

export interface WorkflowDefinition {
  readonly $schema?: string;
  readonly description?: string;
  readonly id: string;
  readonly inputSchema?: PortableJsonSchema;
  readonly limits: WorkflowExecutionLimits;
  readonly nodes: readonly WorkflowNode[];
  readonly resultNode: string;
  readonly schemaVersion: typeof WORKFLOW_DEFINITION_SCHEMA_VERSION;
}

export interface ExecutionEvent {
  readonly attempt?: number;
  readonly eventId: string;
  readonly nodeId?: string;
  readonly payload: Readonly<PluginJsonObject>;
  readonly runId: string;
  readonly schemaVersion: typeof EXECUTION_EVENT_SCHEMA_VERSION;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: ExecutionEventType;
  readonly workflowHash: string;
  readonly workflowId: string;
}

export interface AgentExecutorFeatures {
  readonly cancellation: boolean;
  readonly modelRouting: boolean;
  readonly persistentResume: boolean;
  readonly structuredOutput: boolean;
  readonly toolAllowlist: boolean;
  readonly usageReporting: boolean;
  readonly workspaceIsolation: boolean;
}

export interface AgentExecutorCapabilities {
  readonly apiVersion: typeof AGENT_EXECUTOR_API_VERSION;
  readonly features: AgentExecutorFeatures;
  readonly maxConcurrency: number;
  readonly models?: readonly string[];
}

export interface AgentExecutionModelPolicy {
  readonly preferred?: string;
  readonly required?: string;
}

export interface AgentExecutionRequestLimits {
  readonly maxDurationMs: number;
  readonly maxOutputBytes: number;
  readonly maxToolCalls: number;
}

export interface AgentExecutionWorkspace {
  readonly bindingId?: string;
  readonly mode: WorkspaceMode;
  readonly repository?: string;
}

export interface AgentExecutionRequest {
  readonly apiVersion: typeof AGENT_EXECUTOR_API_VERSION;
  readonly attempt: number;
  readonly contextArtifacts: readonly string[];
  readonly idempotencyKey: string;
  readonly limits: AgentExecutionRequestLimits;
  readonly model?: AgentExecutionModelPolicy;
  readonly nodeId: string;
  readonly outputSchema?: PortableJsonSchema;
  readonly permissions: readonly PluginPermission[];
  readonly preferredCapabilities: readonly string[];
  readonly prompt: string;
  readonly requiredCapabilities: readonly string[];
  readonly runId: string;
  readonly workspace: AgentExecutionWorkspace;
}

export interface AgentCancellationRequest {
  readonly apiVersion: typeof AGENT_EXECUTOR_API_VERSION;
  readonly attempt: number;
  readonly nodeId: string;
  readonly runId: string;
}

export type AgentExecutionStatus = 'blocked' | 'cancelled' | 'failed' | 'succeeded';

export type AgentExecutionErrorCode =
  | 'executor-unavailable'
  | 'invalid-output'
  | 'permission-denied'
  | 'timeout'
  | 'tool-failure'
  | 'workspace-conflict'
  | 'unknown';

export interface AgentExecutionError {
  readonly code: AgentExecutionErrorCode;
  readonly details?: Readonly<PluginJsonObject>;
  readonly message: string;
}

export interface AgentExecutionUsage {
  readonly durationMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolCalls: number | null;
}

export interface AgentExecutionResult {
  readonly apiVersion: typeof AGENT_EXECUTOR_API_VERSION;
  readonly artifacts: readonly string[];
  readonly attempt: number;
  readonly executor: {
    readonly id: string;
    readonly model?: string;
  };
  readonly error?: AgentExecutionError;
  readonly findings: readonly ValidationFinding[];
  readonly nodeId: string;
  readonly output?: PluginJsonValue;
  readonly retryable: boolean;
  readonly runId: string;
  readonly status: AgentExecutionStatus;
  readonly usage: AgentExecutionUsage;
}

/** Executes one Agent node; scheduling and retries remain protected-core responsibilities. */
export interface AgentExecutorService extends NamedPluginService {
  cancel?(request: AgentCancellationRequest): Promise<void>;
  describe(): Promise<AgentExecutorCapabilities>;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}

export interface StaticExecutionPlanNode {
  readonly dependents: readonly string[];
  readonly dependsOn: readonly string[];
  readonly id: string;
  readonly layer: number;
  readonly type: WorkflowNodeType;
}

export interface StaticExecutionPlan {
  readonly layers: readonly (readonly string[])[];
  readonly limits: WorkflowExecutionLimits;
  readonly nodes: readonly StaticExecutionPlanNode[];
  readonly resultNode: string;
  readonly schemaVersion: 1;
  readonly workflowHash: string;
  readonly workflowId: string;
}
