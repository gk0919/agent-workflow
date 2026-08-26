import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Ajv2020, ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import type {
  ExecutionEvent,
  PortableJsonSchema,
  StaticExecutionPlan,
  StaticExecutionPlanNode,
  WorkflowDefinition,
  WorkflowDefinitionBundle,
  WorkflowTransitionRequest,
  WorkflowNode,
} from '../contracts/execution.js';
import { errorMessage } from '../types/guards.js';

const MAX_DEFINITION_BYTES = 256 * 1024;
const MAX_DEFINITION_BUNDLE_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_EMBEDDED_SCHEMA_BYTES = 32 * 1024;
const MAX_JSON_DEPTH = 64;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDirectory, '..', '..', '..');
const schemaDirectory = path.join(packageRoot, 'resources', 'schemas');
const require = createRequire(import.meta.url);
const Ajv2020Constructor = (require('ajv/dist/2020.js') as {
  default: typeof Ajv2020;
}).default;
const addFormats = (require('ajv-formats') as { default: FormatsPlugin }).default;

type JsonRecord = Record<string, unknown>;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const inspectPortableJson = (value: unknown, maxBytes: number): string | undefined => {
  const visited = new WeakSet<object>();
  const visit = (current: unknown, depth: number): string | undefined => {
    if (depth > MAX_JSON_DEPTH) {
      return `JSON 深度超过 ${MAX_JSON_DEPTH} 层上限`;
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return undefined;
    }
    if (typeof current === 'number') {
      return Number.isFinite(current) ? undefined : 'JSON 数字必须是有限值';
    }
    if (typeof current !== 'object') {
      return `包含不可序列化的 ${typeof current} 值`;
    }
    if (visited.has(current)) {
      return 'JSON 值包含循环对象引用';
    }
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) {
        const finding = visit(item, depth + 1);
        if (finding) {
          return finding;
        }
      }
      visited.delete(current);
      return undefined;
    }
    const prototype = Object.getPrototypeOf(current) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return 'JSON 对象必须是普通对象';
    }
    for (const nested of Object.values(current as JsonRecord)) {
      const finding = visit(nested, depth + 1);
      if (finding) {
        return finding;
      }
    }
    visited.delete(current);
    return undefined;
  };

  const finding = visit(value, 0);
  if (finding) {
    return finding;
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    return `JSON 数据超过 ${maxBytes} 字节上限`;
  }
  return undefined;
};

const portableJsonFinding = (value: unknown, maxBytes: number): string | undefined => {
  try {
    return inspectPortableJson(value, maxBytes);
  } catch {
    return 'JSON 值无法安全读取';
  }
};

const createAjv = (): Ajv2020 => {
  const ajv = new Ajv2020Constructor({
    addUsedSchema: false,
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
    useDefaults: false,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv;
};

const readSchema = (name: string): JsonRecord => JSON.parse(
  readFileSync(path.join(schemaDirectory, name), 'utf8'),
) as JsonRecord;

const contractAjv = createAjv();
const workflowDefinitionSchema = readSchema('workflow-definition.schema.json');
contractAjv.addSchema(workflowDefinitionSchema);
const workflowDefinitionValidator = contractAjv.getSchema(
  'https://agent-workflow.local/schemas/workflow-definition.schema.json',
) as ValidateFunction<WorkflowDefinition>;
const workflowDefinitionBundleValidator = contractAjv.compile<WorkflowDefinitionBundle>(
  readSchema('workflow-definition-bundle.schema.json'),
);
const workflowTransitionValidator = contractAjv.compile<WorkflowTransitionRequest>(
  readSchema('workflow-transition.schema.json'),
);
const executionEventValidator = contractAjv.compile<ExecutionEvent>(
  readSchema('execution-event.schema.json'),
);

const formatAjvError = (error: ErrorObject): string => {
  const location = error.instancePath || '$';
  const parameter = (name: string): string | undefined => {
    const value = error.params[name];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  };
  const message = (() => {
    switch (error.keyword) {
      case 'additionalProperties':
        return `不允许字段 ${parameter('additionalProperty') ?? '<unknown>'}`;
      case 'const':
      case 'enum':
        return '值不在允许范围';
      case 'format':
        return `必须符合 ${parameter('format') ?? '指定'} 格式`;
      case 'maxItems':
      case 'maxLength':
      case 'maxProperties':
      case 'maximum':
        return `超过上限 ${parameter('limit') ?? '<unknown>'}`;
      case 'minItems':
      case 'minLength':
      case 'minProperties':
      case 'minimum':
        return `低于下限 ${parameter('limit') ?? '<unknown>'}`;
      case 'oneOf':
        return '必须且只能匹配一种结构';
      case 'pattern':
        return '格式不符合约束';
      case 'required':
        return `缺少必填字段 ${parameter('missingProperty') ?? '<unknown>'}`;
      case 'type':
        return `必须是 ${parameter('type') ?? '指定类型'}`;
      case 'unevaluatedProperties':
        return `不允许字段 ${parameter('unevaluatedProperty') ?? '<unknown>'}`;
      case 'uniqueItems':
        return '数组元素必须唯一';
      default:
        return `未通过 ${error.keyword} 校验`;
    }
  })();
  return `${location}: ${message}`;
};

const formatAjvErrors = (validator: ValidateFunction): string[] => [
  ...new Set((validator.errors ?? []).map(formatAjvError)),
].sort();

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

export const serializeCanonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));
const canonicalJson = serializeCanonicalJson;

export const hashPortableJson = (
  value: unknown,
  maxBytes = MAX_DEFINITION_BYTES,
): string => {
  const finding = portableJsonFinding(value, maxBytes);
  if (finding) {
    throw new Error(`JSON 值无效：${finding}`);
  }
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
};

const workflowDefinitionHash = (definition: WorkflowDefinition): string => {
  const hashInput = Object.fromEntries(
    Object.entries(definition).filter(([key]) => key !== '$schema'),
  );
  return createHash('sha256').update(canonicalJson(hashInput)).digest('hex');
};

const findNonLocalReference = (value: unknown, location = '$'): string | undefined => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const reference = findNonLocalReference(value[index], `${location}/${index}`);
      if (reference) {
        return reference;
      }
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  for (const [key, nested] of Object.entries(value as JsonRecord)) {
    const nestedLocation = `${location}/${key}`;
    if (key === '$ref' && typeof nested === 'string' && !nested.startsWith('#')) {
      return nestedLocation;
    }
    const reference = findNonLocalReference(nested, nestedLocation);
    if (reference) {
      return reference;
    }
  }
  return undefined;
};

const validateEmbeddedSchema = (
  schema: PortableJsonSchema,
  location: string,
): string[] => {
  const findings: string[] = [];
  if (Buffer.byteLength(canonicalJson(schema), 'utf8') > MAX_EMBEDDED_SCHEMA_BYTES) {
    findings.push(`${location}: JSON Schema 超过 ${MAX_EMBEDDED_SCHEMA_BYTES} 字节上限`);
    return findings;
  }
  const nonLocalReference = findNonLocalReference(schema);
  if (nonLocalReference) {
    findings.push(`${location}${nonLocalReference.slice(1)}: 只允许本地片段 $ref`);
    return findings;
  }
  try {
    createAjv().compile(schema);
  } catch {
    findings.push(`${location}: JSON Schema 无效`);
  }
  return findings;
};

export const validateJsonValue = (
  schema: PortableJsonSchema,
  value: unknown,
  maxBytes = MAX_DEFINITION_BYTES,
): string[] => {
  const portableFinding = portableJsonFinding(value, maxBytes);
  if (portableFinding) {
    return [`$: ${portableFinding}`];
  }
  const schemaFindings = validateEmbeddedSchema(schema, '$schema');
  if (schemaFindings.length > 0) {
    return schemaFindings;
  }
  const validator = createAjv().compile(schema);
  if (validator(value)) {
    return [];
  }
  return formatAjvErrors(validator);
};

const semanticFindings = (definition: WorkflowDefinition): string[] => {
  const findings: string[] = [];
  const repositoryPathPattern = /^(?:\.|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/;
  const nodesById = new Map<string, WorkflowNode>();
  const duplicateIds = new Set<string>();

  for (const node of definition.nodes) {
    if (nodesById.has(node.id)) {
      duplicateIds.add(node.id);
    } else {
      nodesById.set(node.id, node);
    }
  }
  for (const id of [...duplicateIds].sort()) {
    findings.push(`$.nodes: 节点标识重复：${id}`);
  }

  if (definition.limits.maxConcurrency > definition.limits.maxAgents) {
    findings.push('$.limits.maxConcurrency: 不得超过 maxAgents');
  }
  const agentUpperBound = definition.nodes.reduce((total, node) => {
    if (node.type === 'agent') {
      return total + 1;
    }
    return node.type === 'map' ? total + node.maxItems : total;
  }, 0);
  if (agentUpperBound > definition.limits.maxAgents) {
    findings.push(`$.limits.maxAgents: Agent 节点超过上限（调用上界 ${agentUpperBound}）`);
  }
  const writeEffectUpperBound = definition.nodes.reduce((total, node) => {
    if (node.type === 'integrator') {
      return total + 1;
    }
    if ((node.type === 'agent' || node.type === 'map') && node.effect) {
      return total + (node.type === 'map' ? node.maxItems : 1);
    }
    return total;
  }, 0);
  if (writeEffectUpperBound > definition.limits.maxExternalWrites) {
    findings.push(
      `$.limits.maxExternalWrites: 写入 effect 超过上限（调用上界 ${writeEffectUpperBound}）`,
    );
  }

  const hasAncestor = (node: WorkflowNode, ancestorId: string): boolean => {
    const pending = [...(node.dependsOn ?? [])];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop();
      if (!id || visited.has(id)) {
        continue;
      }
      if (id === ancestorId) {
        return true;
      }
      visited.add(id);
      pending.push(...(nodesById.get(id)?.dependsOn ?? []));
    }
    return false;
  };

  const dependents = new Map<string, Set<string>>(
    [...nodesById.keys()].map((id) => [id, new Set<string>()]),
  );
  for (const node of definition.nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (dependency === node.id) {
        findings.push(`$.nodes/${node.id}/dependsOn: 节点不能依赖自身`);
      } else if (!nodesById.has(dependency)) {
        findings.push(`$.nodes/${node.id}/dependsOn: 依赖不存在：${dependency}`);
      } else {
        dependents.get(dependency)?.add(node.id);
      }
    }

    if (node.type === 'agent' || node.type === 'map') {
      const required = new Set(node.requiredCapabilities ?? []);
      const overlap = (node.preferredCapabilities ?? [])
        .filter((capability) => required.has(capability))
        .sort();
      if (overlap.length > 0) {
        findings.push(
          `$.nodes/${node.id}: requiredCapabilities 与 preferredCapabilities 重复：${overlap.join(', ')}`,
        );
      }
      if (node.outputSchema !== undefined) {
        findings.push(...validateEmbeddedSchema(node.outputSchema, `$.nodes/${node.id}/outputSchema`));
      }
      if (node.effect) {
        const templatedValues = [
          ...(node.effect.ownedPaths ?? []),
          ...(node.effect.resourceLocks ?? []),
        ];
        if (templatedValues.some((value) => value.replaceAll('{lane}', '').includes('{') ||
          value.replaceAll('{lane}', '').includes('}'))) {
          findings.push(`$.nodes/${node.id}/effect: 只支持 {lane} 模板变量`);
        }
        if (node.type === 'agent' && templatedValues.some((value) => value.includes('{lane}'))) {
          findings.push(`$.nodes/${node.id}/effect: agent 节点不能使用 {lane}`);
        }
        const checkpoint = nodesById.get(node.effect.approvalCheckpoint);
        if (checkpoint?.type !== 'checkpoint') {
          findings.push(
            `$.nodes/${node.id}/effect/approvalCheckpoint: 必须引用 checkpoint 节点`,
          );
        } else if (!hasAncestor(node, checkpoint.id)) {
          findings.push(
            `$.nodes/${node.id}/effect/approvalCheckpoint: checkpoint 必须是写节点祖先`,
          );
        }
        if (node.effect.kind === 'repository-write') {
          if (!(node.effect.ownedPaths?.length)) {
            findings.push(`$.nodes/${node.id}/effect/ownedPaths: 仓库写入必须声明 ownership`);
          }
          if (
            node.workspace?.mode !== 'exclusive-worktree' ||
            !node.workspace.repository
          ) {
            findings.push(
              `$.nodes/${node.id}/workspace: 仓库写入必须声明 repository 和 exclusive-worktree`,
            );
          } else if (!repositoryPathPattern.test(node.workspace.repository)) {
            findings.push(`$.nodes/${node.id}/workspace/repository: 必须是规范工作区相对路径`);
          }
          if (!(node.permissions ?? []).includes('workspace:write')) {
            findings.push(`$.nodes/${node.id}/permissions: 仓库写入必须声明 workspace:write`);
          }
        } else if (node.effect.ownedPaths !== undefined) {
          findings.push(`$.nodes/${node.id}/effect/ownedPaths: 外部写入不能声明仓库 ownership`);
        }
      } else if ((node.permissions ?? []).includes('workspace:write')) {
        findings.push(`$.nodes/${node.id}/permissions: workspace:write 必须绑定 repository-write effect`);
      }
    }
    if (
      (node.type === 'agent' || node.type === 'map') &&
      node.effect?.kind === 'repository-write'
    ) {
      const integrators = definition.nodes.filter((candidate) =>
        candidate.type === 'integrator' && candidate.dependsOn.includes(node.id));
      if (integrators.length !== 1) {
        findings.push(
          `$.nodes/${node.id}: repository-write 必须由且仅由一个直接 Integrator 消费`,
        );
      }
    }
    if (node.type === 'integrator') {
      const checkpoint = nodesById.get(node.approvalCheckpoint);
      if (checkpoint?.type !== 'checkpoint' || !hasAncestor(node, node.approvalCheckpoint)) {
        findings.push(
          `$.nodes/${node.id}/approvalCheckpoint: 必须引用上游 checkpoint 节点`,
        );
      }
      for (const dependencyId of node.dependsOn) {
        const dependency = nodesById.get(dependencyId);
        if (
          !dependency ||
          (dependency.type !== 'agent' && dependency.type !== 'map') ||
          dependency.effect?.kind !== 'repository-write' ||
          dependency.workspace?.repository !== node.repository
        ) {
          findings.push(
            `$.nodes/${node.id}/dependsOn: Integrator 只能直接依赖同仓库 repository-write 节点：${dependencyId}`,
          );
        }
      }
    }
    if (node.type === 'parallel') {
      const minSuccess = node.minSuccess ?? node.dependsOn.length;
      if (minSuccess > node.dependsOn.length) {
        findings.push(`$.nodes/${node.id}/minSuccess: 不得超过依赖数量`);
      }
      if (
        node.mode === 'adversarial' &&
        (node.dependsOn.length < 2 || minSuccess < 2)
      ) {
        findings.push(`$.nodes/${node.id}: adversarial 模式至少需要两个分支成功`);
      }
      const nonAgentBranches = node.mode === 'adversarial'
        ? node.dependsOn.filter((id) => {
          const dependency = nodesById.get(id);
          return dependency && dependency.type !== 'agent' && dependency.type !== 'map';
        })
        : [];
      if (nonAgentBranches.length > 0) {
        findings.push(
          `$.nodes/${node.id}: adversarial 分支必须是 agent 或 map：${nonAgentBranches.join(', ')}`,
        );
      }
    }
  }
  if (definition.inputSchema !== undefined) {
    findings.push(...validateEmbeddedSchema(definition.inputSchema, '$.inputSchema'));
  }

  const result = nodesById.get(definition.resultNode);
  if (!result) {
    findings.push(`$.resultNode: 节点不存在：${definition.resultNode}`);
  } else if ((dependents.get(result.id)?.size ?? 0) > 0) {
    findings.push(`$.resultNode: 结果节点必须是终端节点：${result.id}`);
  }

  if (duplicateIds.size === 0) {
    const indegree = new Map<string, number>();
    for (const node of definition.nodes) {
      indegree.set(
        node.id,
        (node.dependsOn ?? []).filter((dependency) => nodesById.has(dependency)).length,
      );
    }
    const ready = [...indegree.entries()]
      .filter(([, count]) => count === 0)
      .map(([id]) => id)
      .sort();
    let visited = 0;
    while (ready.length > 0) {
      const id = ready.shift();
      if (!id) {
        break;
      }
      visited += 1;
      for (const dependent of [...(dependents.get(id) ?? [])].sort()) {
        const nextCount = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, nextCount);
        if (nextCount === 0) {
          ready.push(dependent);
          ready.sort();
        }
      }
    }
    if (visited !== nodesById.size) {
      const cyclic = [...indegree.entries()]
        .filter(([, count]) => count > 0)
        .map(([id]) => id)
        .sort();
      findings.push(`$.nodes: 工作流图包含环：${cyclic.join(', ')}`);
    }
  }

  if (result) {
    const ancestors = new Set<string>();
    const pending = [result.id];
    while (pending.length > 0) {
      const id = pending.pop();
      if (!id || ancestors.has(id)) {
        continue;
      }
      ancestors.add(id);
      const node = nodesById.get(id);
      pending.push(...(node?.dependsOn ?? []).filter((dependency) => nodesById.has(dependency)));
    }
    const deadNodes = [...nodesById.keys()].filter((id) => !ancestors.has(id)).sort();
    if (deadNodes.length > 0) {
      findings.push(`$.nodes: 以下节点不会贡献到 resultNode：${deadNodes.join(', ')}`);
    }
  }

  return [...new Set(findings)].sort();
};

export const validateWorkflowDefinition = (value: unknown): string[] => {
  const portableFinding = portableJsonFinding(value, MAX_DEFINITION_BYTES);
  if (portableFinding) {
    return [`$: ${portableFinding}`];
  }
  if (!workflowDefinitionValidator(value)) {
    return formatAjvErrors(workflowDefinitionValidator);
  }
  return semanticFindings(value as WorkflowDefinition);
};

export const validateWorkflowDefinitionBundle = (value: unknown): string[] => {
  const portableFinding = portableJsonFinding(value, MAX_DEFINITION_BUNDLE_BYTES);
  if (portableFinding) {
    return [`$: ${portableFinding}`];
  }
  if (!workflowDefinitionBundleValidator(value)) {
    return formatAjvErrors(workflowDefinitionBundleValidator);
  }
  const bundle = value as WorkflowDefinitionBundle;
  const findings = validateWorkflowDefinition(bundle.definition).map((finding) =>
    finding.startsWith('$') ? `$.definition${finding.slice(1)}` : `$.definition: ${finding}`);
  if (bundle.workflowId !== bundle.definition.id) {
    findings.push('$.workflowId: 必须与 definition.id 一致');
  }
  if (bundle.definitionHash !== workflowDefinitionHash(bundle.definition)) {
    findings.push('$.definitionHash: 必须与 definition 内容哈希一致');
  }
  if (bundle.previousVersion && bundle.previousVersion.version >= bundle.version) {
    findings.push('$.previousVersion.version: 必须小于当前 version');
  }
  return [...new Set(findings)].sort();
};

/** Validates the portable Phase 6 parent-to-child transition request contract. */
export const validateWorkflowTransitionRequest = (value: unknown): string[] => {
  const portableFinding = portableJsonFinding(value, MAX_DEFINITION_BUNDLE_BYTES);
  if (portableFinding) {
    return [`$: ${portableFinding}`];
  }
  if (!workflowTransitionValidator(value)) {
    return formatAjvErrors(workflowTransitionValidator);
  }
  const request = value as WorkflowTransitionRequest;
  const findings = validateWorkflowDefinition(request.definition).map((finding) =>
    finding.startsWith('$') ? `$.definition${finding.slice(1)}` : `$.definition: ${finding}`);
  return [...new Set(findings)].sort();
};

export const validateExecutionEvent = (value: unknown): string[] => {
  const portableFinding = portableJsonFinding(value, MAX_EVENT_BYTES);
  if (portableFinding) {
    return [`$: ${portableFinding}`];
  }
  if (executionEventValidator(value)) {
    return [];
  }
  return formatAjvErrors(executionEventValidator);
};

const buildLayers = (definition: WorkflowDefinition): string[][] => {
  const dependents = new Map<string, string[]>(
    definition.nodes.map((node) => [node.id, []]),
  );
  const indegree = new Map<string, number>();
  for (const node of definition.nodes) {
    indegree.set(node.id, node.dependsOn?.length ?? 0);
    for (const dependency of node.dependsOn ?? []) {
      dependents.get(dependency)?.push(node.id);
    }
  }
  let ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const layers: string[][] = [];
  while (ready.length > 0) {
    const layer = ready;
    layers.push(layer);
    const next: string[] = [];
    for (const id of layer) {
      for (const dependent of (dependents.get(id) ?? []).sort()) {
        const count = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, count);
        if (count === 0) {
          next.push(dependent);
        }
      }
    }
    ready = next.sort();
  }
  return layers;
};

export const compileStaticExecutionPlan = (value: unknown): StaticExecutionPlan => {
  const findings = validateWorkflowDefinition(value);
  if (findings.length > 0) {
    throw new Error(`工作流定义无效：\n- ${findings.join('\n- ')}`);
  }
  const definition = value as WorkflowDefinition;
  const layers = buildLayers(definition);
  const layerById = new Map(
    layers.flatMap((ids, layer) => ids.map((id) => [id, layer] as const)),
  );
  const dependents = new Map<string, string[]>(
    definition.nodes.map((node) => [node.id, []]),
  );
  for (const node of definition.nodes) {
    for (const dependency of node.dependsOn ?? []) {
      dependents.get(dependency)?.push(node.id);
    }
  }
  const nodes: StaticExecutionPlanNode[] = definition.nodes
    .map((node) => ({
      dependents: Object.freeze([...(dependents.get(node.id) ?? [])].sort()),
      dependsOn: Object.freeze([...(node.dependsOn ?? [])].sort()),
      id: node.id,
      layer: layerById.get(node.id) ?? 0,
      type: node.type,
    }))
    .sort((left, right) => left.layer - right.layer || compareStrings(left.id, right.id));
  const workflowHash = workflowDefinitionHash(definition);
  return Object.freeze({
    layers: Object.freeze(layers.map((layer) => Object.freeze([...layer]))),
    limits: Object.freeze({
      maxAgents: definition.limits.maxAgents,
      maxAttemptsPerNode: definition.limits.maxAttemptsPerNode,
      maxConcurrency: definition.limits.maxConcurrency,
      maxDurationMs: definition.limits.maxDurationMs,
      maxExternalWrites: definition.limits.maxExternalWrites,
      maxIterations: definition.limits.maxIterations,
    }),
    nodes: Object.freeze(nodes.map((node) => Object.freeze(node))),
    resultNode: definition.resultNode,
    schemaVersion: 1,
    workflowHash,
    workflowId: definition.id,
  });
};

const resolveDefinitionFile = (workspaceRoot: string, file: string): string => {
  if (!file || path.isAbsolute(file) || path.win32.isAbsolute(file)) {
    throw new Error('--file 必须是工作区相对路径');
  }
  const segments = file.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error('--file 包含非法路径片段');
  }
  const realWorkspace = realpathSync(workspaceRoot);
  const candidate = realpathSync(path.resolve(realWorkspace, ...segments));
  const relative = path.relative(realWorkspace, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--file 必须位于当前工作区内');
  }
  const fileStats = statSync(candidate);
  if (!fileStats.isFile()) {
    throw new Error('--file 必须指向 JSON 文件');
  }
  if (path.extname(candidate).toLowerCase() !== '.json') {
    throw new Error('--file 必须指向 .json 文件');
  }
  if (fileStats.size > MAX_DEFINITION_BYTES) {
    throw new Error(`工作流定义超过 ${MAX_DEFINITION_BYTES} 字节上限`);
  }
  return candidate;
};

const renderTextPlan = (plan: StaticExecutionPlan): string => [
  `Workflow: ${plan.workflowId}`,
  `Hash: ${plan.workflowHash}`,
  `Result: ${plan.resultNode}`,
  `Limits: agents=${plan.limits.maxAgents}, concurrency=${plan.limits.maxConcurrency}, attempts=${plan.limits.maxAttemptsPerNode}`,
  'Layers:',
  ...plan.layers.map((layer, index) => `  ${index}: ${layer.join(', ')}`),
  '',
].join('\n');

const printUsage = (): void => {
  process.stdout.write([
    'Usage: agent-workflow execution:plan --file <workspace-relative-json> [--format text|json]',
    '',
  ].join('\n'));
};

export const main = async (args = process.argv.slice(2)): Promise<number> => {
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: false,
      options: {
        file: { type: 'string' },
        format: { type: 'string', default: 'text' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    });
    if (parsed.values.help) {
      printUsage();
      return 0;
    }
    if (!parsed.values.file) {
      throw new Error('缺少 --file');
    }
    if (parsed.values.format !== 'text' && parsed.values.format !== 'json') {
      throw new Error('--format 仅支持 text 或 json');
    }
    const { workspaceRoot } = await import('../config/workspace-paths.js');
    const definitionPath = resolveDefinitionFile(workspaceRoot, parsed.values.file);
    const definition = JSON.parse(readFileSync(definitionPath, 'utf8')) as unknown;
    const plan = compileStaticExecutionPlan(definition);
    process.stdout.write(parsed.values.format === 'json'
      ? `${canonicalJson(plan)}\n`
      : renderTextPlan(plan));
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`静态执行计划生成失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
