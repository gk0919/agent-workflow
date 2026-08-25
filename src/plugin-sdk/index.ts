import type {
  AgentAdapterService,
  ApprovalProviderService,
  ArtifactStoreService,
  ContextProviderService,
  ReporterService,
  RouteExtensionService,
  SourceProviderService,
  ValidatorService,
} from '../contracts/capabilities.js';
import type { AgentExecutorService } from '../contracts/execution.js';
import type {
  PluginPermission,
  ServiceDefinition,
  WorkflowEventMap,
  WorkflowPlugin,
} from '../contracts/plugin.js';
import { STANDARD_PLUGIN_SERVICES } from '../contracts/plugin.js';
import type { PluginJsonObject } from '../contracts/json.js';

export * from '../contracts/index.js';

const SERVICE_ID_PATTERN = /^[a-z0-9]+(?:[.:/-][a-z0-9]+)*$/;

export interface DefineServiceOptions {
  /** Allow more than one active provider for this service. */
  multiple?: boolean;
  /** Permission checked whenever a plugin resolves this host service. */
  permission?: PluginPermission;
}

/** Defines a stable service token without relying on package-local symbols. */
export const defineService = <TValue>(
  id: string,
  options: DefineServiceOptions = {},
): ServiceDefinition<TValue> => {
  if (!SERVICE_ID_PATTERN.test(id)) {
    throw new Error(`非法插件服务标识：${id}`);
  }
  return Object.freeze({
    id,
    multiple: options.multiple ?? false,
    ...(options.permission ? { permission: options.permission } : {}),
  });
};

/** Preserves plugin generics while making the module's default export explicit. */
export const definePlugin = <
  TEvents extends object = WorkflowEventMap,
  TOptions extends Readonly<PluginJsonObject> = Readonly<PluginJsonObject>,
>(plugin: WorkflowPlugin<TEvents, TOptions>): WorkflowPlugin<TEvents, TOptions> => plugin;

export const sourceProviderService = defineService<SourceProviderService>(
  STANDARD_PLUGIN_SERVICES['source-provider'],
  { multiple: true },
);
export const agentAdapterService = defineService<AgentAdapterService>(
  STANDARD_PLUGIN_SERVICES['agent-adapter'],
  { multiple: true },
);
export const agentExecutorService = defineService<AgentExecutorService>(
  STANDARD_PLUGIN_SERVICES['agent-executor'],
  { multiple: true },
);
export const contextProviderService = defineService<ContextProviderService>(
  STANDARD_PLUGIN_SERVICES['context-provider'],
  { multiple: true },
);
export const validatorService = defineService<ValidatorService>(
  STANDARD_PLUGIN_SERVICES.validator,
  { multiple: true },
);
export const routeExtensionService = defineService<RouteExtensionService>(
  STANDARD_PLUGIN_SERVICES['route-extension'],
  { multiple: true },
);
export const approvalProviderService = defineService<ApprovalProviderService>(
  STANDARD_PLUGIN_SERVICES['approval-provider'],
  { multiple: true },
);
export const artifactStoreService = defineService<ArtifactStoreService>(
  STANDARD_PLUGIN_SERVICES['artifact-store'],
  { multiple: true },
);
export const reporterService = defineService<ReporterService>(
  STANDARD_PLUGIN_SERVICES.reporter,
  { multiple: true },
);
