import type {
  NamedPluginService,
  ValidationFinding,
} from './capabilities.js';
import type { PluginJsonObject, PluginJsonValue } from './json.js';
import type { PluginPermission } from './plugin.js';

export const WORKFLOW_DEFINITION_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_DEFINITION_BUNDLE_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_AUTHORING_SCHEMA_VERSION = 1 as const;
export const EXECUTION_EVENT_SCHEMA_VERSION = 1 as const;
export const AGENT_EXECUTOR_API_VERSION = 1 as const;
export const FAKE_EXECUTOR_FIXTURE_SCHEMA_VERSION = 1 as const;

export const WORKFLOW_NODE_TYPES = [
  'agent',
  'checkpoint',
  'gate',
  'integrator',
  'join',
  'map',
  'parallel',
  'reduce',
] as const;
export type WorkflowNodeType = typeof WORKFLOW_NODE_TYPES[number];

export const WORKFLOW_EXECUTION_MODES = [
  'parallel-readonly',
  'serial',
  'writable-worktree',
] as const;
export type WorkflowExecutionMode = typeof WORKFLOW_EXECUTION_MODES[number];

export const WORKFLOW_DEFINITION_SOURCES = [
  'builder',
  'human',
  'migration',
  'model',
] as const;
export type WorkflowDefinitionSource = typeof WORKFLOW_DEFINITION_SOURCES[number];

export const EXECUTION_EVENT_TYPES = [
  'run.created',
  'run.started',
  'node.scheduled',
  'node.started',
  'node.workspace-bound',
  'node.effect-prepared',
  'node.output-validated',
  'node.effect-confirmed',
  'node.completed',
  'node.failed',
  'node.retry-scheduled',
  'run.checkpointed',
  'run.paused',
  'run.resumed',
  'run.cancelled',
  'run.completed',
  'run.failed',
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
  readonly effect?: WorkflowEffectRequirement;
  readonly failurePolicy?: WorkflowFailurePolicy;
  readonly outputSchema?: PortableJsonSchema;
  readonly permissions?: readonly PluginPermission[];
  readonly preferredCapabilities?: readonly string[];
  readonly prompt: string;
  readonly requiredCapabilities?: readonly string[];
  readonly type: 'agent';
  readonly workspace?: WorkflowWorkspaceRequirement;
}

export type WorkflowFailurePolicy = 'fail-fast' | 'isolate';

export type WorkflowEffectKind = 'external-write' | 'repository-write';

export interface WorkflowEffectRequirement {
  readonly approvalCheckpoint: string;
  readonly kind: WorkflowEffectKind;
  readonly ownedPaths?: readonly string[];
  readonly resourceLocks?: readonly string[];
}

export interface MapWorkflowNode extends WorkflowNodeBase {
  readonly dependsOn: readonly [string];
  readonly effect?: WorkflowEffectRequirement;
  readonly failurePolicy?: WorkflowFailurePolicy;
  readonly itemsPointer?: string;
  readonly maxItems: number;
  readonly outputSchema?: PortableJsonSchema;
  readonly permissions?: readonly PluginPermission[];
  readonly preferredCapabilities?: readonly string[];
  readonly prompt: string;
  readonly requiredCapabilities?: readonly string[];
  readonly type: 'map';
  readonly workspace?: WorkflowWorkspaceRequirement;
}

export type WorkflowParallelMode = 'adversarial' | 'independent';

export interface ParallelWorkflowNode extends WorkflowNodeBase {
  readonly dependsOn: readonly string[];
  readonly minSuccess?: number;
  readonly mode: WorkflowParallelMode;
  readonly type: 'parallel';
}

export type WorkflowReduceStrategy = 'collect' | 'dedupe';

export interface ReduceWorkflowNode extends WorkflowNodeBase {
  readonly dependsOn: readonly string[];
  readonly itemsPointer?: string;
  readonly strategy: WorkflowReduceStrategy;
  readonly type: 'reduce';
}

export interface JoinWorkflowNode extends WorkflowNodeBase {
  readonly dependsOn: readonly string[];
  readonly type: 'join';
}

export interface IntegratorWorkflowNode extends WorkflowNodeBase {
  readonly approvalCheckpoint: string;
  readonly dependsOn: readonly string[];
  readonly repository: string;
  readonly type: 'integrator';
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
  | IntegratorWorkflowNode
  | JoinWorkflowNode
  | MapWorkflowNode
  | ParallelWorkflowNode
  | ReduceWorkflowNode;

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

export interface WorkflowDefinitionBundlePreviousVersion {
  readonly definitionHash: string;
  readonly version: number;
}

/** Portable saved form for versioning model-, builder- or human-authored definitions. */
export interface WorkflowDefinitionBundle {
  readonly $schema?: string;
  readonly definition: WorkflowDefinition;
  readonly definitionHash: string;
  readonly kind: 'workflow-definition-bundle';
  readonly previousVersion?: WorkflowDefinitionBundlePreviousVersion;
  readonly schemaVersion: typeof WORKFLOW_DEFINITION_BUNDLE_SCHEMA_VERSION;
  readonly source: WorkflowDefinitionSource;
  readonly version: number;
  readonly workflowId: string;
}

export interface ExecutionEvent {
  readonly attempt?: number;
  readonly eventHash?: string;
  readonly eventId: string;
  readonly laneId?: string;
  readonly nodeId?: string;
  readonly payload: Readonly<PluginJsonObject>;
  readonly previousEventHash?: string | null;
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
  readonly capabilities?: readonly string[];
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

export interface AgentExecutionLane {
  readonly id: string;
  readonly index: number;
  readonly itemArtifact: string;
}

export interface AgentExecutionWorkspace {
  readonly baseCommit?: string;
  readonly bindingId?: string;
  readonly mode: WorkspaceMode;
  readonly repository?: string;
  readonly rootPath?: string;
}

export interface AgentExecutionRequest {
  readonly apiVersion: typeof AGENT_EXECUTOR_API_VERSION;
  readonly attempt: number;
  readonly contextArtifacts: readonly string[];
  readonly idempotencyKey: string;
  readonly limits: AgentExecutionRequestLimits;
  readonly lane?: AgentExecutionLane;
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
  readonly laneId?: string;
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
  readonly laneId?: string;
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

export interface ExecutionWorkspaceBinding {
  readonly baseCommit: string;
  readonly bindingId: string;
  readonly nodeId: string;
  readonly laneId?: string;
  readonly ownedPaths: readonly string[];
  readonly repository: string;
  /** Host-local path; never persist it in portable Events or Artifacts. */
  readonly rootPath: string;
}

export interface ExecutionWorkspaceBindRequest {
  readonly laneId?: string;
  readonly nodeId: string;
  readonly ownedPaths: readonly string[];
  readonly purpose: 'agent' | 'integrator';
  readonly repository: string;
  readonly runId: string;
}

export interface ExecutionWorkspaceChange {
  readonly baseCommit: string;
  readonly bindingId: string;
  readonly changedPaths: readonly string[];
  readonly commit: string;
  readonly effectId: string;
  readonly outputArtifact: ExecutionArtifactReference;
  readonly ownedPaths: readonly string[];
  readonly repository: string;
}

export interface ExecutionWorkspaceFinalizeRequest {
  readonly binding: ExecutionWorkspaceBinding;
  readonly effectId: string;
  readonly outputArtifact: ExecutionArtifactReference;
}

export interface ExecutionWorkspaceRecoveryRequest {
  readonly binding: ExecutionWorkspaceBinding;
  readonly effectId: string;
}

export type ExecutionWorkspaceRecoveryStatus = 'ambiguous' | 'ready' | 'recovered';

export interface ExecutionWorkspaceRecoveryResult {
  readonly change?: ExecutionWorkspaceChange;
  readonly message?: string;
  readonly status: ExecutionWorkspaceRecoveryStatus;
}

export interface ExecutionIntegrationFinding {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'info' | 'warning';
}

export interface ExecutionIntegrationRequest {
  readonly approvalCheckpoint: string;
  readonly changes: readonly ExecutionWorkspaceChange[];
  readonly effectId: string;
  readonly nodeId: string;
  readonly repository: string;
  readonly runId: string;
}

export type ExecutionIntegrationStatus = 'conflicted' | 'failed' | 'succeeded';

export interface ExecutionIntegrationResult {
  readonly baseCommit: string;
  readonly bindingId: string;
  readonly changedPaths: readonly string[];
  readonly commit?: string;
  readonly conflicts: readonly string[];
  readonly findings: readonly ExecutionIntegrationFinding[];
  readonly repository: string;
  readonly status: ExecutionIntegrationStatus;
}

/** Host-owned Git/workspace effects; Kernel remains filesystem and shell agnostic. */
export interface ExecutionWorkspaceService extends NamedPluginService {
  bind(request: ExecutionWorkspaceBindRequest): Promise<ExecutionWorkspaceBinding>;
  finalize(request: ExecutionWorkspaceFinalizeRequest): Promise<ExecutionWorkspaceChange>;
  integrate(request: ExecutionIntegrationRequest): Promise<ExecutionIntegrationResult>;
  recover(request: ExecutionWorkspaceRecoveryRequest): Promise<ExecutionWorkspaceRecoveryResult>;
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

export interface WorkflowAuthoringBudgetPreview {
  readonly declared: WorkflowExecutionLimits;
  readonly maxEffectInvocations: number;
  readonly maxExecutorCalls: number;
  readonly maxLayerWidth: number;
  readonly nodeCount: number;
}

export interface WorkflowAuthoringCheckpointPreview {
  readonly id: string;
  readonly summary: string;
}

export interface WorkflowAuthoringEffectPreview {
  readonly approvalCheckpoint: string;
  readonly kind: WorkflowEffectKind;
  readonly maxInvocations: number;
  readonly nodeId: string;
  readonly ownedPaths?: readonly string[];
  readonly repository?: string;
  readonly resourceLocks?: readonly string[];
}

export interface WorkflowAuthoringRequirementsPreview {
  readonly permissions: readonly PluginPermission[];
  readonly preferredCapabilities: readonly string[];
  readonly repositories: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly writable: boolean;
}

/** Deterministic approval surface derived from validated declarative IR. */
export interface WorkflowAuthoringPreview {
  readonly budget: WorkflowAuthoringBudgetPreview;
  readonly checkpoints: readonly WorkflowAuthoringCheckpointPreview[];
  readonly effects: readonly WorkflowAuthoringEffectPreview[];
  readonly executionMode: WorkflowExecutionMode;
  readonly plan: StaticExecutionPlan;
  readonly previewHash: string;
  readonly requirements: WorkflowAuthoringRequirementsPreview;
  readonly schemaVersion: typeof WORKFLOW_AUTHORING_SCHEMA_VERSION;
  readonly workflowHash: string;
  readonly workflowId: string;
}

/** Host-issued receipt proving that the exact preview was approved before execution. */
export interface WorkflowExecutionApproval {
  readonly executionMode: WorkflowExecutionMode;
  readonly previewHash: string;
  readonly schemaVersion: typeof WORKFLOW_AUTHORING_SCHEMA_VERSION;
  readonly workflowHash: string;
}

export interface ExecutionArtifactReference {
  readonly byteLength: number;
  readonly id: string;
  readonly mediaType: 'application/json';
  readonly sha256: string;
}

export type ExecutionRunStatus = 'cancelled' | 'completed' | 'failed' | 'paused';

export type ExecutionRunErrorCode =
  | 'budget-exhausted'
  | 'checkpoint-required'
  | 'definition-mismatch'
  | 'executor-blocked'
  | 'executor-incompatible'
  | 'effect-recovery-required'
  | 'input-invalid'
  | 'journal-corrupt'
  | 'merge-conflict'
  | 'node-failed'
  | 'paused'
  | 'verification-failed';

export interface ExecutionRunError {
  readonly code: ExecutionRunErrorCode;
  readonly message: string;
  readonly nodeId?: string;
}

export interface ExecutionRunNodeSummary {
  readonly artifact?: ExecutionArtifactReference;
  readonly attempts: number;
  readonly id: string;
  readonly status: 'completed' | 'failed' | 'pending';
  readonly type: WorkflowNodeType;
}

export interface ExecutionNodeUsageSummary {
  readonly attempts: number;
  readonly durationMs: number;
  readonly executorCalls: number;
  readonly failedCalls: number;
  readonly inputTokens: number | null;
  readonly nodeId: string;
  readonly outputTokens: number | null;
  readonly toolCalls: number | null;
}

export interface ExecutionRunUsageSummary {
  readonly attempts: number;
  readonly durationMs: number;
  readonly executorCalls: number;
  readonly failedCalls: number;
  readonly inputTokens: number | null;
  readonly maxConcurrencyObserved: number;
  readonly nodes: readonly ExecutionNodeUsageSummary[];
  readonly outputTokens: number | null;
  readonly toolCalls: number | null;
}

export interface ExecutionRunResult {
  readonly error?: ExecutionRunError;
  readonly eventCount: number;
  readonly nodes: readonly ExecutionRunNodeSummary[];
  readonly result?: PluginJsonValue;
  readonly resultArtifact?: ExecutionArtifactReference;
  readonly runId: string;
  readonly status: ExecutionRunStatus;
  readonly usage?: ExecutionRunUsageSummary;
  readonly workflowHash: string;
  readonly workflowId: string;
}

export interface ExecutionControlResult {
  readonly eventCount: number;
  readonly runId: string;
  readonly status: 'cancelled' | 'completed' | 'failed' | 'paused';
}

/** Append-only event and content-addressed JSON persistence used by the execution kernel. */
export interface ExecutionJournalStore {
  readonly runId: string;
  append(event: ExecutionEvent): void;
  readEvents(): readonly ExecutionEvent[];
  readJsonArtifact(reference: ExecutionArtifactReference): PluginJsonValue;
  writeJsonArtifact(value: PluginJsonValue): ExecutionArtifactReference;
}

export interface FakeExecutorAttemptFixture {
  readonly artifacts?: readonly string[];
  readonly delayMs?: number;
  readonly error?: AgentExecutionError;
  readonly findings?: readonly ValidationFinding[];
  readonly output?: PluginJsonValue;
  readonly retryable?: boolean;
  readonly status: AgentExecutionStatus;
  readonly usage?: Partial<AgentExecutionUsage>;
}

export interface FakeExecutorNodeFixture {
  readonly attempts: readonly FakeExecutorAttemptFixture[];
  readonly laneId?: string;
  readonly nodeId: string;
}

export interface FakeExecutorFixture {
  readonly $schema?: string;
  readonly capabilities: AgentExecutorCapabilities;
  readonly executorId: string;
  readonly nodes: readonly FakeExecutorNodeFixture[];
  readonly schemaVersion: typeof FAKE_EXECUTOR_FIXTURE_SCHEMA_VERSION;
}
