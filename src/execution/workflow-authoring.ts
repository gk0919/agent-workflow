import type { PluginPermission } from '../contracts/plugin.js';
import {
  WORKFLOW_AUTHORING_SCHEMA_VERSION,
  WORKFLOW_DEFINITION_BUNDLE_SCHEMA_VERSION,
  WORKFLOW_DEFINITION_SOURCES,
  WORKFLOW_EXECUTION_MODES,
  type PortableJsonSchema,
  type WorkflowAuthoringEffectPreview,
  type WorkflowAuthoringPreview,
  type WorkflowDefinition,
  type WorkflowDefinitionBundle,
  type WorkflowDefinitionBundlePreviousVersion,
  type WorkflowDefinitionSource,
  type WorkflowExecutionApproval,
  type WorkflowExecutionLimits,
  type WorkflowExecutionMode,
  type WorkflowRunTransitionContext,
  type WorkflowNode,
  type ExecutionRunResult,
} from '../contracts/execution.js';
import {
  compileStaticExecutionPlan,
  hashPortableJson,
  serializeCanonicalJson,
  validateWorkflowDefinitionBundle,
} from '../core/execution-plan.js';
import { executionModePolicyFindings } from './execution-policy.js';
import {
  runParallelWorkflowWithApprovalContext,
  runSerialWorkflowWithApprovalContext,
  runWritableWorkflowWithApprovalContext,
  type ParallelExecutionOptions,
} from './serial-runner.js';

const MAX_AUTHORING_OUTPUT_BYTES = 512 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const clonePortable = <T>(value: T): T =>
  JSON.parse(serializeCanonicalJson(value)) as T;

const freezePortable = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as JsonRecord).forEach((nested) => freezePortable(nested));
  }
  return value;
};

const parseAuthoringValue = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_AUTHORING_OUTPUT_BYTES) {
    throw new Error(`动态 Workflow 输出超过 ${MAX_AUTHORING_OUTPUT_BYTES} 字节上限`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('动态 Workflow 输出必须是单个 JSON Definition 或 Bundle，不能包含 Markdown 或说明文本');
  }
};

const isBundleCandidate = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (value as JsonRecord).kind === 'workflow-definition-bundle';

/** Parses untrusted model or host output into validated, frozen declarative IR. */
export const parseWorkflowDefinitionOutput = (value: unknown): WorkflowDefinition => {
  const candidate = parseAuthoringValue(value);
  if (isBundleCandidate(candidate)) {
    const bundle = loadWorkflowDefinitionBundle(candidate);
    return freezePortable(clonePortable(bundle.definition));
  }
  const plan = compileStaticExecutionPlan(candidate);
  const definition = freezePortable(clonePortable(candidate as WorkflowDefinition));
  if (plan.workflowHash !== compileStaticExecutionPlan(definition).workflowHash) {
    throw new Error('动态 Workflow Definition 在规范化后发生漂移');
  }
  return definition;
};

/** Validates a persisted Bundle and its definition/hash/version invariants. */
export const loadWorkflowDefinitionBundle = (value: unknown): WorkflowDefinitionBundle => {
  const candidate = parseAuthoringValue(value);
  const findings = validateWorkflowDefinitionBundle(candidate);
  if (findings.length > 0) {
    throw new Error(`Workflow Definition Bundle 无效：\n- ${findings.join('\n- ')}`);
  }
  return freezePortable(clonePortable(candidate as WorkflowDefinitionBundle));
};

export interface CreateWorkflowDefinitionBundleOptions {
  readonly previousVersion?: WorkflowDefinitionBundlePreviousVersion;
  readonly source: WorkflowDefinitionSource;
  readonly version: number;
}

/** Creates the current portable saved envelope without adding executable behavior. */
export const createWorkflowDefinitionBundle = (
  value: unknown,
  options: CreateWorkflowDefinitionBundleOptions,
): WorkflowDefinitionBundle => {
  if (!WORKFLOW_DEFINITION_SOURCES.includes(options.source)) {
    throw new Error('Workflow Definition Bundle source 不受支持');
  }
  if (!Number.isInteger(options.version) || options.version < 1 || options.version > 2147483647) {
    throw new Error('Workflow Definition Bundle version 必须是正整数');
  }
  const definition = parseWorkflowDefinitionOutput(value);
  const plan = compileStaticExecutionPlan(definition);
  const bundle: WorkflowDefinitionBundle = {
    definition,
    definitionHash: plan.workflowHash,
    kind: 'workflow-definition-bundle',
    ...(options.previousVersion
      ? { previousVersion: clonePortable(options.previousVersion) }
      : {}),
    schemaVersion: WORKFLOW_DEFINITION_BUNDLE_SCHEMA_VERSION,
    source: options.source,
    version: options.version,
    workflowId: definition.id,
  };
  return loadWorkflowDefinitionBundle(bundle);
};

export interface MigrateWorkflowDefinitionOptions {
  readonly version?: number;
}

/** Wraps legacy raw Definition v1 files and validates current Bundle files unchanged. */
export const migrateWorkflowDefinitionArtifact = (
  value: unknown,
  options: MigrateWorkflowDefinitionOptions = {},
): WorkflowDefinitionBundle => {
  const candidate = parseAuthoringValue(value);
  if (isBundleCandidate(candidate)) {
    return loadWorkflowDefinitionBundle(candidate);
  }
  return createWorkflowDefinitionBundle(candidate, {
    source: 'migration',
    version: options.version ?? 1,
  });
};

export interface WorkflowDefinitionBuilderOptions {
  readonly description?: string;
  readonly inputSchema?: PortableJsonSchema;
}

/** Optional authoring convenience that can only emit validated declarative IR. */
export class WorkflowDefinitionBuilder {
  readonly #id: string;
  readonly #limits: WorkflowExecutionLimits;
  readonly #nodes: WorkflowNode[] = [];
  #description: string | undefined;
  #inputSchema: PortableJsonSchema | undefined;
  #resultNode = '';

  constructor(
    id: string,
    limits: WorkflowExecutionLimits,
    options: WorkflowDefinitionBuilderOptions = {},
  ) {
    this.#id = id;
    this.#limits = clonePortable(limits);
    this.#description = options.description;
    this.#inputSchema = options.inputSchema
      ? clonePortable(options.inputSchema)
      : options.inputSchema;
  }

  addNode(node: WorkflowNode): this {
    this.#nodes.push(clonePortable(node));
    return this;
  }

  setDescription(description: string): this {
    this.#description = description;
    return this;
  }

  setInputSchema(inputSchema: PortableJsonSchema): this {
    this.#inputSchema = clonePortable(inputSchema);
    return this;
  }

  setResultNode(nodeId: string): this {
    this.#resultNode = nodeId;
    return this;
  }

  build(): WorkflowDefinition {
    return parseWorkflowDefinitionOutput({
      ...(this.#description ? { description: this.#description } : {}),
      id: this.#id,
      ...(this.#inputSchema !== undefined ? { inputSchema: this.#inputSchema } : {}),
      limits: this.#limits,
      nodes: this.#nodes,
      resultNode: this.#resultNode,
      schemaVersion: 1,
    });
  }
}

const effectPreview = (
  node: Extract<WorkflowNode, { type: 'agent' | 'map' }>,
): WorkflowAuthoringEffectPreview | undefined => {
  if (!node.effect) {
    return undefined;
  }
  return {
    approvalCheckpoint: node.effect.approvalCheckpoint,
    kind: node.effect.kind,
    maxInvocations: node.type === 'map' ? node.maxItems : 1,
    nodeId: node.id,
    ...(node.effect.ownedPaths
      ? { ownedPaths: Object.freeze([...node.effect.ownedPaths].sort(compareStrings)) }
      : {}),
    ...(node.workspace?.repository ? { repository: node.workspace.repository } : {}),
    ...(node.effect.resourceLocks
      ? { resourceLocks: Object.freeze([...node.effect.resourceLocks].sort(compareStrings)) }
      : {}),
  };
};

/** Produces the exact graph, budget and authority surface that a host must approve. */
export const previewWorkflowDefinition = (
  value: unknown,
  executionMode: WorkflowExecutionMode = 'parallel-readonly',
): WorkflowAuthoringPreview => {
  if (!WORKFLOW_EXECUTION_MODES.includes(executionMode)) {
    throw new Error(`动态 Workflow executionMode 不受支持：${executionMode}`);
  }
  const definition = parseWorkflowDefinitionOutput(value);
  const plan = compileStaticExecutionPlan(definition);
  const policyFindings = executionModePolicyFindings(definition, executionMode);
  if (policyFindings.length > 0) {
    throw new Error(`动态 Workflow 执行策略拒绝：\n- ${policyFindings.join('\n- ')}`);
  }
  const executableNodes = definition.nodes.filter((node) =>
    node.type === 'agent' || node.type === 'map');
  const effects = executableNodes
    .map((node) => effectPreview(node))
    .filter((effect): effect is WorkflowAuthoringEffectPreview => Boolean(effect))
    .sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  const unique = <T extends string>(items: readonly T[]): T[] =>
    [...new Set(items)].sort(compareStrings);
  const repositories = unique(definition.nodes.flatMap((node) => {
    if (node.type === 'integrator') {
      return [node.repository];
    }
    return node.type === 'agent' || node.type === 'map'
      ? node.workspace?.repository ? [node.workspace.repository] : []
      : [];
  }));
  const maxAgentInvocations = executableNodes.reduce(
    (total, node) => total + (node.type === 'map' ? node.maxItems : 1),
    0,
  );
  const previewWithoutHash = {
    budget: {
      declared: plan.limits,
      maxEffectInvocations: effects.reduce((total, effect) =>
        total + effect.maxInvocations, 0),
      maxExecutorCalls: maxAgentInvocations * definition.limits.maxAttemptsPerNode,
      maxLayerWidth: Math.max(...plan.layers.map((layer) => layer.length)),
      nodeCount: definition.nodes.length,
    },
    checkpoints: definition.nodes
      .filter((node) => node.type === 'checkpoint')
      .map((node) => ({ id: node.id, summary: node.approvalSummary }))
      .sort((left, right) => compareStrings(left.id, right.id)),
    effects,
    executionMode,
    plan,
    requirements: {
      permissions: unique(executableNodes.flatMap((node) => [...(node.permissions ?? [])])) as PluginPermission[],
      preferredCapabilities: unique(executableNodes.flatMap((node) =>
        [...(node.preferredCapabilities ?? [])])),
      repositories,
      requiredCapabilities: unique(executableNodes.flatMap((node) =>
        [...(node.requiredCapabilities ?? [])])),
      writable: executionMode === 'writable-worktree',
    },
    schemaVersion: WORKFLOW_AUTHORING_SCHEMA_VERSION,
    workflowHash: plan.workflowHash,
    workflowId: plan.workflowId,
  };
  return freezePortable({
    ...previewWithoutHash,
    previewHash: hashPortableJson(previewWithoutHash),
  });
};

/** Compares an untrusted host receipt with the exact current approval preview. */
export const validateWorkflowExecutionApproval = (
  preview: WorkflowAuthoringPreview,
  value: unknown,
): string[] => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['批准回执必须是对象'];
  }
  const approval = value as JsonRecord;
  const expectedKeys = ['executionMode', 'previewHash', 'schemaVersion', 'workflowHash'];
  const keys = Object.keys(approval).sort(compareStrings);
  const findings: string[] = [];
  if (serializeCanonicalJson(keys) !== serializeCanonicalJson(expectedKeys)) {
    findings.push('批准回执字段必须严格匹配 executionMode/previewHash/schemaVersion/workflowHash');
  }
  if (approval.schemaVersion !== WORKFLOW_AUTHORING_SCHEMA_VERSION) {
    findings.push('批准回执 schemaVersion 不受支持');
  }
  if (approval.executionMode !== preview.executionMode) {
    findings.push('批准回执 executionMode 与当前预览不一致');
  }
  if (typeof approval.workflowHash !== 'string' || !SHA256_PATTERN.test(approval.workflowHash) ||
      approval.workflowHash !== preview.workflowHash) {
    findings.push('批准回执 workflowHash 与当前 Definition 不一致');
  }
  if (typeof approval.previewHash !== 'string' || !SHA256_PATTERN.test(approval.previewHash) ||
      approval.previewHash !== preview.previewHash) {
    findings.push('批准回执 previewHash 与当前图、预算或权限预览不一致');
  }
  return findings.sort(compareStrings);
};

export interface ApprovedWorkflowExecutionOptions
  extends Omit<ParallelExecutionOptions, 'approvalContext' | 'definition'> {
  readonly approval: WorkflowExecutionApproval;
  readonly definition: unknown;
  readonly executionMode: WorkflowExecutionMode;
}

interface InternalApprovedWorkflowExecutionOptions extends ApprovedWorkflowExecutionOptions {
  readonly transitionContext?: WorkflowRunTransitionContext;
}

const runApprovedWorkflowInternal = async (
  options: InternalApprovedWorkflowExecutionOptions,
): Promise<ExecutionRunResult> => {
  const definition = parseWorkflowDefinitionOutput(options.definition);
  const preview = previewWorkflowDefinition(definition, options.executionMode);
  const approvalFindings = validateWorkflowExecutionApproval(preview, options.approval);
  if (approvalFindings.length > 0) {
    throw new Error(`动态 Workflow 未获当前预览批准：\n- ${approvalFindings.join('\n- ')}`);
  }
  const {
    approval: _approval,
    executionMode,
    transitionContext,
    ...executionOptions
  } = options;
  const approvalContext = {
    executionMode,
    previewHash: preview.previewHash,
    schemaVersion: WORKFLOW_AUTHORING_SCHEMA_VERSION,
    ...(transitionContext ? { transition: transitionContext } : {}),
    workflowHash: preview.workflowHash,
  };
  const resolvedOptions: ParallelExecutionOptions = {
    ...executionOptions,
    definition,
  };
  switch (executionMode) {
    case 'serial':
      return await runSerialWorkflowWithApprovalContext(resolvedOptions, approvalContext);
    case 'parallel-readonly':
      return await runParallelWorkflowWithApprovalContext(resolvedOptions, approvalContext);
    case 'writable-worktree':
      return await runWritableWorkflowWithApprovalContext(resolvedOptions, approvalContext);
  }
};

/** Recomputes the preview before any Journal write, then delegates to the existing Runner. */
export const runApprovedWorkflow = async (
  options: ApprovedWorkflowExecutionOptions,
): Promise<ExecutionRunResult> => await runApprovedWorkflowInternal(options);

/** Internal Phase 6 bridge; intentionally omitted from the package public exports. */
export const runApprovedWorkflowWithTransitionContext = async (
  options: ApprovedWorkflowExecutionOptions,
  transitionContext: WorkflowRunTransitionContext,
): Promise<ExecutionRunResult> => await runApprovedWorkflowInternal({
  ...options,
  transitionContext,
});
