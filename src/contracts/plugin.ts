import type { PluginJsonObject } from './json.js';

/** Current public plugin contract understood by this workflow host. */
export const PLUGIN_API_VERSION = 1 as const;

/** Stable extension roles. A plugin may provide more than one role. */
export const PLUGIN_CAPABILITIES = [
  'source-provider',
  'agent-adapter',
  'agent-executor',
  'execution-workspace',
  'context-provider',
  'validator',
  'route-extension',
  'approval-provider',
  'artifact-store',
  'reporter',
  'tool-provider',
  'knowledge-provider',
] as const;

export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];

/** Canonical service ids for capabilities with an executable v1 contract. */
export const STANDARD_PLUGIN_SERVICES = Object.freeze({
  'agent-adapter': 'workflow/agent-adapter',
  'agent-executor': 'workflow/agent-executor',
  'execution-workspace': 'workflow/execution-workspace',
  'approval-provider': 'workflow/approval-provider',
  'artifact-store': 'workflow/artifact-store',
  'context-provider': 'workflow/context-provider',
  reporter: 'workflow/reporter',
  'route-extension': 'workflow/route-extension',
  'source-provider': 'workflow/source-provider',
  validator: 'workflow/validator',
} as const satisfies Partial<Record<PluginCapability, string>>);

/**
 * Auditable permissions granted to trusted in-process plugins.
 *
 * These permissions constrain host-provided services; they are not an OS sandbox.
 * Plugins that need isolation must use the process or remote transport boundary.
 */
export const PLUGIN_PERMISSIONS = [
  'workspace:read',
  'workspace:write',
  'process:spawn',
  'network:connect',
  'secrets:read',
  'artifact:read',
  'artifact:write',
  'telemetry:emit',
] as const;

export type PluginPermission = typeof PLUGIN_PERMISSIONS[number];

export interface PluginDependencies {
  /** Plugin identifiers that must activate first. */
  plugins?: readonly string[];
  /** Service identifiers that must exist before activation. */
  services?: readonly string[];
}

export interface PluginContributions {
  /** Service identifiers registered during setup. */
  services?: readonly string[];
}

/** Immutable identity and dependency declaration exported by every plugin. */
export interface PluginManifest {
  apiVersion: typeof PLUGIN_API_VERSION;
  capabilities: readonly PluginCapability[];
  description?: string;
  id: string;
  permissions?: readonly PluginPermission[];
  provides?: PluginContributions;
  requires?: PluginDependencies;
  version: string;
}

/** JSON configuration for one plugin installed in the consuming workspace. */
export interface PluginConfiguration {
  /** Permissions explicitly granted by the host project. */
  permissions?: readonly PluginPermission[];
  enabled?: boolean;
  /** Must match the loaded manifest and prevents accidental module substitution. */
  id: string;
  /** Workspace-relative JavaScript file or package specifier. */
  module: string;
  options?: Readonly<PluginJsonObject>;
}

export type PluginHostState = 'idle' | 'starting' | 'running' | 'stopping';

export interface PluginStatus {
  capabilities: readonly PluginCapability[];
  id: string;
  state: 'active' | 'inactive';
  version: string;
}

export interface PluginLifecycleEvent {
  pluginId: string;
}

export interface WorkflowCommandEvent {
  command: string;
}

export interface WorkflowCommandResultEvent extends WorkflowCommandEvent {
  exitCode: number;
}

/**
 * Built-in events remain intentionally small. Consumers may extend this
 * interface with an application-specific event map.
 */
export interface WorkflowEventMap {
  'command:after': WorkflowCommandResultEvent;
  'command:before': WorkflowCommandEvent;
  'plugin:activated': PluginLifecycleEvent;
  'plugin:activating': PluginLifecycleEvent;
  'plugin:deactivated': PluginLifecycleEvent;
  'plugin:deactivating': PluginLifecycleEvent;
}

declare const serviceValueType: unique symbol;

/** A stable, typed key used for dependency injection across package boundaries. */
export interface ServiceDefinition<TValue> {
  readonly id: string;
  readonly multiple: boolean;
  readonly permission?: PluginPermission;
  readonly [serviceValueType]?: TValue;
}

export interface ServiceRegistration<TValue = unknown> {
  readonly service: ServiceDefinition<TValue>;
  readonly value: TValue;
}

export type PluginCleanup = () => Promise<void> | void;
export type PluginSetupResult = PluginCleanup | void;

export type WorkflowEventName<TEvents extends object> = Extract<keyof TEvents, string>;
export type WorkflowEventHandler<
  TEvents extends object,
  TName extends WorkflowEventName<TEvents>,
> = (event: TEvents[TName]) => Promise<void> | void;

export interface PluginContext<
  TEvents extends object = WorkflowEventMap,
  TOptions extends Readonly<PluginJsonObject> = Readonly<PluginJsonObject>,
> {
  /** Granted permissions after manifest/config reconciliation. */
  readonly grantedPermissions: ReadonlySet<PluginPermission>;
  readonly manifest: PluginManifest;
  readonly options: TOptions;
  /** Emits handlers serially to preserve deterministic ordering. */
  emit<TName extends WorkflowEventName<TEvents>>(
    name: TName,
    event: TEvents[TName],
  ): Promise<void>;
  /** Registers setup and its optional cleanup as one reversible effect. */
  effect(setup: () => PluginSetupResult | Promise<PluginSetupResult>): Promise<void>;
  /** Gets one service and rejects ambiguous multi-provider resolution. */
  get<TValue>(service: ServiceDefinition<TValue>): TValue;
  getAll<TValue>(service: ServiceDefinition<TValue>): readonly TValue[];
  getOptional<TValue>(service: ServiceDefinition<TValue>): TValue | undefined;
  /** Subscriptions are automatically removed during plugin deactivation. */
  on<TName extends WorkflowEventName<TEvents>>(
    name: TName,
    handler: WorkflowEventHandler<TEvents, TName>,
  ): void;
  /** Service registrations are automatically removed during deactivation. */
  provide<TValue>(service: ServiceDefinition<TValue>, value: TValue): void;
}

export interface WorkflowPlugin<
  TEvents extends object = WorkflowEventMap,
  TOptions extends Readonly<PluginJsonObject> = Readonly<PluginJsonObject>,
> {
  readonly manifest: PluginManifest;
  setup(context: PluginContext<TEvents, TOptions>): PluginSetupResult | Promise<PluginSetupResult>;
}
