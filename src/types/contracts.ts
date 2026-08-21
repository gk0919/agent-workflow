import type { PluginConfiguration } from '../contracts/plugin.js';

/** JSON-compatible primitive values accepted by workflow configuration files. */
export type JsonPrimitive = boolean | null | number | string;

/** JSON-compatible value used at untrusted file and process boundaries. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** Object form of a JSON value. Properties remain unknown until validated. */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** Generic object boundary for values that may not yet be proven JSON-compatible. */
export type UnknownRecord = Record<string, unknown>;

export interface WorkflowPathConfig {
  knowledgeRoot: string;
  runtimeRoot: string;
  skillsRoot: string;
  tasksRoot: string;
}

export type WorkflowPathKey = keyof WorkflowPathConfig;

export interface WorkflowConfig {
  $schema?: string;
  activeProfile: string;
  paths: WorkflowPathConfig;
  plugins?: PluginConfiguration[];
  schemaVersion: 1;
}

export interface WorkflowPaths extends WorkflowPathConfig {
  routes: string;
}

export interface TaskModel {
  artifactEntryModes: string[];
  changeEntryModes: string[];
  changeIntents: string[];
  changeTypeByIntent: Record<string, string>;
  changeTypes: string[];
  evolutionaryChangeTypes: string[];
  expectedIntentEntries: Record<string, string[]>;
  intakeStage: string;
  intentRoutes: Record<string, [string, string] | null>;
  knownStages: string[];
  microStages: Record<string, string>;
  providerEntryMode: string;
  sourceCaptureStage: string;
  sourceTypes: string[];
}

export interface SourceProvider {
  kind: string;
  name?: string;
}

export interface WorkflowProfile {
  $schema?: string;
  description: string;
  evals: { routeCases: string };
  governance: {
    denyEagerDocs: string[];
    deprecatedReferences: string[];
    forbiddenStagedPatterns: string[];
    markdownFiles: string[];
    markdownRoots: string[];
    requiredPaths: string[];
  };
  id: string;
  issueTracking: {
    enabled: boolean;
    enforceEnvironment: string;
    flags: string;
    label: string;
    pattern: string;
    requiredForTypes: string[];
  };
  review: { defaultSkill: string };
  schemaVersion: 1;
  setup: { requiredPaths: string[] };
  sourceProviders: Record<string, SourceProvider>;
  taskModel: TaskModel;
}

export interface RouteTaskFlow {
  optionalStages: string[];
  stages: string[];
  transitions: Record<string, string[]>;
}

export interface RouteStage {
  docs: string[];
  next: string;
  references?: string[];
  taskStages?: string[];
}

export interface RouteDefinition {
  budgetChars: number;
  disallowedRiskFlags: string[];
  entryModes: string[];
  onFailure: string;
  reasonCodes: string[];
  references?: string[];
  skillReserveChars: number;
  stagePaths?: Record<string, string[]>;
  stages: Record<string, RouteStage>;
  taskFlow?: RouteTaskFlow;
  taskRequiredStages?: string[];
}

export interface RoutesConfig {
  baseDocs: string[];
  denyEagerDocs: string[];
  globalReferences: string[];
  limits: {
    alwaysOnMaxChars: number;
    cardMaxChars: number;
    routePacketReserveChars: number;
    routeWarningRemainingRatio: number;
    toolOutputDefaultChars: number;
  };
  microChangeGate: {
    maxFiles: number;
    maxSemanticLines: number;
    minFiles: number;
    minSemanticLines: number;
    repositories: number;
  };
  riskCatalog: string[];
  routes: Record<string, RouteDefinition>;
  verificationContract: {
    requiredForSpecsCreatedOnOrAfter: string;
    version: number;
  };
  version: number;
}

export interface RouteFacts {
  acceptanceClear: boolean;
  behaviorClear: boolean;
  changeType: string;
  compatibilityClear: boolean;
  entry: string;
  files: number;
  goalClear: boolean;
  hasValidationPath: boolean;
  intent: string;
  noNewBusinessState: boolean;
  repositories: number;
  requestsAsync: boolean;
  requestsIndependentReview: boolean;
  requestsPersistence: boolean;
  riskFlags: string[];
  semanticLines: number;
  uniqueLocation: boolean;
  usesExistingPattern: boolean;
}

export interface RouteClassification {
  blockers: string[];
  changeClass: string | null;
  changeType: string | null;
  entry: string;
  microChangeEligible: boolean;
  reasonCodes: string[];
  riskFlags: string[];
  route: string;
  stage: string;
}

export interface RepositoryBinding {
  repository: string;
  repositoryId: string;
}

export interface MicroGuardSummary {
  files?: string[];
  fileCount: number;
  patchHash: string;
  repositoryId?: string;
  repositoryCount: number;
  semanticLines: number;
  sourceHash: string;
}

export interface MicroBriefSummary {
  acceptanceCount: number;
  briefHash?: string;
  changeCount: number;
  goalCount: number;
  outOfScopeCount: number;
  planHash: string;
  verificationCount: number;
}

export interface RoutePacketBase {
  budgetChars: number;
  changeType: string | null;
  decision: {
    classified: boolean;
    confidence: number | null;
    confidenceBasis: string;
    onFailure: string;
    reasonCodes: string[];
    riskFlags: string[];
  };
  entry: string;
  instructionDocs: string[];
  loadedChars: number;
  materializeContentChars: number;
  materializeDocs: string[];
  microBrief: MicroBriefSummary | null;
  microGuard: MicroGuardSummary | null;
  microRepository: RepositoryBinding | null;
  next: string;
  optionalReferences: string[];
  packetReserveChars: number;
  parentRunId: string;
  profile: { id: string; reviewSkill: string; sourceProvider: string };
  referenceDocs: string[];
  route: string;
  routesVersion: number;
  runId: string;
  skillDocs: string[];
  stage: string;
  taskId: string;
  toolOutputDefaultChars: number;
  usedChars: number;
}

export interface RoutePacket extends RoutePacketBase {
  packetChars: number;
}

export type TaskStatus = 'blocked' | 'complete' | 'in_progress' | 'pending';
export type StageStatus = TaskStatus | 'skipped';

export interface TaskStageState {
  evidence: string;
  name: string;
  status: StageStatus;
}
