import {
  AGENT_EXECUTOR_API_VERSION,
  type AgentExecutorCapabilities,
  type WorkflowDefinition,
} from '../contracts/execution.js';

export type ExecutorConcurrencyMode = 'parallel' | 'serial' | 'serial-fallback';

export interface ExecutorCapabilityNegotiation {
  readonly compatible: boolean;
  readonly degradedCapabilities: readonly string[];
  readonly effectiveConcurrency: number;
  readonly errors: readonly string[];
  readonly mode: ExecutorConcurrencyMode;
  readonly requestedConcurrency: number;
  readonly supportedCapabilities: readonly string[];
}

const FEATURE_CAPABILITIES: ReadonlyArray<[
  keyof AgentExecutorCapabilities['features'],
  string,
]> = [
  ['cancellation', 'cancellation'],
  ['modelRouting', 'model-routing'],
  ['persistentResume', 'persistent-resume'],
  ['structuredOutput', 'structured-output'],
  ['toolAllowlist', 'tool-allowlist'],
  ['usageReporting', 'usage-reporting'],
  ['workspaceIsolation', 'workspace-isolation'],
];

export const supportedExecutorCapabilities = (
  capabilities: AgentExecutorCapabilities,
): readonly string[] => {
  const supported = new Set(capabilities.capabilities ?? []);
  for (const [key, name] of FEATURE_CAPABILITIES) {
    if (capabilities.features[key]) {
      supported.add(name);
    }
  }
  return [...supported].sort();
};

/** Pure capability negotiation shared by native, process and future remote executors. */
export const negotiateExecutorCapabilities = (
  definition: WorkflowDefinition,
  capabilities: AgentExecutorCapabilities,
): ExecutorCapabilityNegotiation => {
  const errors: string[] = [];
  if (capabilities.apiVersion !== AGENT_EXECUTOR_API_VERSION) {
    errors.push(`Executor API 版本不兼容：${capabilities.apiVersion}`);
  }
  const validConcurrency = Number.isInteger(capabilities.maxConcurrency) &&
    capabilities.maxConcurrency >= 1;
  if (!validConcurrency) {
    errors.push('Executor maxConcurrency 必须至少为 1');
  }

  const supportedCapabilities = supportedExecutorCapabilities(capabilities);
  const supported = new Set(supportedCapabilities);
  const degradedCapabilities: string[] = [];
  for (const node of definition.nodes) {
    if (node.type !== 'agent' && node.type !== 'map') {
      continue;
    }
    const missingRequired = (node.requiredCapabilities ?? [])
      .filter((capability) => !supported.has(capability))
      .sort();
    if (missingRequired.length > 0) {
      errors.push(`节点 ${node.id} 缺少 required capability：${missingRequired.join(', ')}`);
    }
    if (node.effect && !supported.has('tool-allowlist')) {
      errors.push(`节点 ${node.id} 的写入 effect 要求 tool-allowlist capability`);
    }
    if (
      node.effect?.kind === 'repository-write' &&
      !supported.has('workspace-isolation')
    ) {
      errors.push(`节点 ${node.id} 的仓库写入要求 workspace-isolation capability`);
    }
    degradedCapabilities.push(...(node.preferredCapabilities ?? [])
      .filter((capability) => !supported.has(capability))
      .map((capability) => `${node.id}:${capability}`));
  }

  const requestedConcurrency = definition.limits.maxConcurrency;
  const effectiveConcurrency = validConcurrency
    ? Math.min(requestedConcurrency, capabilities.maxConcurrency)
    : 1;
  if (validConcurrency && effectiveConcurrency < requestedConcurrency) {
    degradedCapabilities.push(`executor-concurrency:${capabilities.maxConcurrency}`);
  }
  const mode: ExecutorConcurrencyMode = effectiveConcurrency > 1
    ? 'parallel'
    : requestedConcurrency > 1
      ? 'serial-fallback'
      : 'serial';

  const stableErrors = [...new Set(errors)].sort();
  return {
    compatible: stableErrors.length === 0,
    degradedCapabilities: [...new Set(degradedCapabilities)].sort(),
    effectiveConcurrency,
    errors: stableErrors,
    mode,
    requestedConcurrency,
    supportedCapabilities,
  };
};
