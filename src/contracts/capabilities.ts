import type { PluginJsonValue } from './json.js';

export interface NamedPluginService {
  /** Stable identifier used when multiple providers implement the same capability. */
  readonly id: string;
}

export interface SourceCaptureRequest {
  readonly entry: string;
  readonly reference?: string;
}

export interface SourceCaptureResult {
  readonly capturedAt: string;
  readonly facts: Readonly<Record<string, PluginJsonValue>>;
  readonly sourceId: string;
  readonly sourceType: string;
}

export interface SourceProviderService extends NamedPluginService {
  capture(request: SourceCaptureRequest): Promise<SourceCaptureResult>;
}

export interface AgentInstructionRequest {
  readonly content: string;
  readonly metadata?: Readonly<Record<string, PluginJsonValue>>;
}

export interface AgentInstructionResult {
  readonly content: string;
  readonly metadata?: Readonly<Record<string, PluginJsonValue>>;
}

export interface AgentAdapterService extends NamedPluginService {
  adapt(request: AgentInstructionRequest): Promise<AgentInstructionResult>;
}

export interface ContextRequest {
  readonly route: string;
  readonly runId: string;
  readonly stage: string;
  readonly taskId?: string;
}

export interface ContextFragment {
  readonly content: string;
  readonly id: string;
  readonly priority: number;
  readonly source: string;
}

export interface ContextProviderService extends NamedPluginService {
  load(request: ContextRequest): Promise<readonly ContextFragment[]>;
}

export type ValidationSeverity = 'error' | 'info' | 'warning';

export interface ValidationRequest {
  readonly artifactType: string;
  readonly value: PluginJsonValue;
}

export interface ValidationFinding {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly severity: ValidationSeverity;
}

export interface ValidatorService extends NamedPluginService {
  validate(request: ValidationRequest): Promise<readonly ValidationFinding[]>;
}

export interface RouteEvaluationRequest {
  readonly facts: Readonly<Record<string, PluginJsonValue>>;
  readonly profileId: string;
}

export interface RouteCandidate {
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly route: string;
  readonly stage: string;
}

/**
 * Contributes candidates only. The protected router remains responsible for
 * risk gates, transition legality and the final route selection.
 */
export interface RouteExtensionService extends NamedPluginService {
  evaluate(request: RouteEvaluationRequest): Promise<readonly RouteCandidate[]>;
}

export interface ApprovalRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly stage: string;
  readonly summary: string;
}

export interface ApprovalDecision {
  readonly actorRef: string;
  readonly decidedAt: string;
  readonly decision: 'approved' | 'rejected';
  readonly requestId: string;
}

/**
 * Collects a human decision. The protected core must still bind the response to
 * the pending request and enforce approval before any guarded transition.
 */
export interface ApprovalProviderService extends NamedPluginService {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface ArtifactDescriptor {
  readonly contentType: string;
  readonly id: string;
  readonly metadata?: Readonly<Record<string, PluginJsonValue>>;
  readonly sha256: string;
  readonly size: number;
}

export interface ArtifactWriteRequest {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly id: string;
  readonly metadata?: Readonly<Record<string, PluginJsonValue>>;
}

export interface ArtifactReadResult {
  readonly content: Uint8Array;
  readonly descriptor: ArtifactDescriptor;
}

export interface ArtifactStoreService extends NamedPluginService {
  get(id: string): Promise<ArtifactReadResult | undefined>;
  put(request: ArtifactWriteRequest): Promise<ArtifactDescriptor>;
}

export interface WorkflowReportEvent {
  readonly name: string;
  readonly payload: Readonly<Record<string, PluginJsonValue>>;
  readonly runId?: string;
  readonly timestamp: string;
}

export interface ReporterService extends NamedPluginService {
  report(event: WorkflowReportEvent): Promise<void>;
}
