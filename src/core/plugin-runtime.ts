import {
  PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  PLUGIN_PERMISSIONS,
  STANDARD_PLUGIN_SERVICES,
} from '../contracts/plugin.js';
import type {
  PluginCapability,
  PluginCleanup,
  PluginConfiguration,
  PluginContext,
  PluginHostState,
  PluginManifest,
  PluginPermission,
  PluginStatus,
  ServiceDefinition,
  ServiceRegistration,
  WorkflowEventHandler,
  WorkflowEventMap,
  WorkflowEventName,
  WorkflowPlugin,
} from '../contracts/plugin.js';
import type { PluginJsonObject, PluginJsonValue } from '../contracts/json.js';

const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SERVICE_ID_PATTERN = /^[a-z0-9]+(?:[.:/-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CORE_PROVIDER_ID = 'workflow-core';
const MANIFEST_KEYS = new Set([
  'apiVersion',
  'capabilities',
  'description',
  'id',
  'permissions',
  'provides',
  'requires',
  'version',
]);
const PROVIDES_KEYS = new Set(['services']);
const REQUIRES_KEYS = new Set(['plugins', 'services']);
const STANDARD_SERVICE_CAPABILITIES: ReadonlyMap<string, PluginCapability> = new Map(
  Object.entries(STANDARD_PLUGIN_SERVICES)
    .map(([capability, serviceId]) => [serviceId, capability as PluginCapability] as const),
);

type UntypedEventHandler = (event: unknown) => Promise<void> | void;

interface StoredEventHandler {
  readonly handler: UntypedEventHandler;
  readonly ownerId: string;
}

interface StoredService {
  readonly definition: ServiceDefinition<unknown>;
  readonly ownerId: string;
  readonly value: unknown;
}

export interface PluginRuntimeInput<
  TEvents extends object = WorkflowEventMap,
> {
  readonly configuration: PluginConfiguration;
  readonly plugin: WorkflowPlugin<TEvents>;
}

export interface PluginRuntimeOptions<
  TEvents extends object = WorkflowEventMap,
> {
  readonly plugins?: readonly PluginRuntimeInput<TEvents>[];
  /** Protected-core services available before any plugin activates. */
  readonly services?: readonly ServiceRegistration[];
}

const uniqueStrings = (values: unknown, label: string): string[] => {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values) ||
      values.some((value) => typeof value !== 'string' || !value)) {
    throw new Error(`${label} 必须是非空字符串数组`);
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length) {
    throw new Error(`${label} 不能包含重复项`);
  }
  return unique;
};

const assertKnownKeys = (
  value: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  label: string,
): void => {
  const unexpected = Object.keys(value).filter((key) => !knownKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} 包含未知字段：${unexpected.join(', ')}`);
  }
};

/** Rejects malformed or incompatible manifests before executing plugin setup. */
export const assertPluginManifest: (
  manifest: unknown,
) => asserts manifest is PluginManifest = (manifest) => {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('插件 Manifest 必须是对象');
  }
  const candidate = manifest as Record<string, unknown>;
  assertKnownKeys(candidate, MANIFEST_KEYS, '插件 Manifest');
  const pluginId = typeof candidate.id === 'string' ? candidate.id : '';
  if (candidate.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `插件 ${pluginId || '<unknown>'} API 版本不兼容：` +
      `${String(candidate.apiVersion)}，宿主要求 ${PLUGIN_API_VERSION}`,
    );
  }
  if (!IDENTIFIER_PATTERN.test(pluginId)) {
    throw new Error(`插件 id 非法：${pluginId}`);
  }
  if (typeof candidate.version !== 'string' || !VERSION_PATTERN.test(candidate.version)) {
    throw new Error(`插件 ${pluginId} version 必须是 SemVer`);
  }
  if (candidate.description !== undefined && typeof candidate.description !== 'string') {
    throw new Error(`插件 ${pluginId} description 必须是字符串`);
  }

  const capabilities = uniqueStrings(candidate.capabilities, `${pluginId}.capabilities`);
  if (capabilities.length === 0 || capabilities.some((capability) =>
    !PLUGIN_CAPABILITIES.includes(capability as PluginCapability))) {
    throw new Error(`插件 ${pluginId} 声明了未知或空 capabilities`);
  }
  const permissions = uniqueStrings(candidate.permissions, `${pluginId}.permissions`);
  if (permissions.some((permission) =>
    !PLUGIN_PERMISSIONS.includes(permission as PluginPermission))) {
    throw new Error(`插件 ${pluginId} 声明了未知 permission`);
  }
  if (candidate.requires !== undefined &&
      (!candidate.requires || typeof candidate.requires !== 'object' ||
        Array.isArray(candidate.requires))) {
    throw new Error(`插件 ${pluginId} requires 必须是对象`);
  }
  if (candidate.provides !== undefined &&
      (!candidate.provides || typeof candidate.provides !== 'object' ||
        Array.isArray(candidate.provides))) {
    throw new Error(`插件 ${pluginId} provides 必须是对象`);
  }
  const requires = candidate.requires as Record<string, unknown> | undefined;
  const provides = candidate.provides as Record<string, unknown> | undefined;
  if (requires) {
    assertKnownKeys(requires, REQUIRES_KEYS, `${pluginId}.requires`);
  }
  if (provides) {
    assertKnownKeys(provides, PROVIDES_KEYS, `${pluginId}.provides`);
  }
  const requiredPlugins = uniqueStrings(
    requires?.plugins,
    `${pluginId}.requires.plugins`,
  );
  if (requiredPlugins.includes(pluginId) ||
      requiredPlugins.some((pluginId) => !IDENTIFIER_PATTERN.test(pluginId))) {
    throw new Error(`插件 ${pluginId} 包含非法插件依赖`);
  }
  const requiredServices = uniqueStrings(
    requires?.services,
    `${pluginId}.requires.services`,
  );
  const providedServices = uniqueStrings(
    provides?.services,
    `${pluginId}.provides.services`,
  );
  if ([...requiredServices, ...providedServices]
    .some((serviceId) => !SERVICE_ID_PATTERN.test(serviceId))) {
    throw new Error(`插件 ${pluginId} 包含非法服务标识`);
  }
  if (requiredServices.some((serviceId) => providedServices.includes(serviceId))) {
    throw new Error(`插件 ${pluginId} 不能同时依赖并提供同一服务`);
  }
  providedServices.forEach((serviceId) => {
    const requiredCapability = STANDARD_SERVICE_CAPABILITIES.get(serviceId);
    if (requiredCapability && !capabilities.includes(requiredCapability)) {
      throw new Error(
        `插件 ${pluginId} 提供 ${serviceId} 时必须声明 ${requiredCapability} capability`,
      );
    }
  });
};

const deepFreezeJson = <TValue extends PluginJsonValue>(value: TValue): TValue => {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreezeJson(item));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => {
      if (item !== undefined) {
        deepFreezeJson(item);
      }
    });
  }
  return Object.freeze(value);
};

const deepFreezeManifest = (manifest: PluginManifest): PluginManifest => {
  const cloned = structuredClone(manifest);
  const freeze = (value: object): void => {
    Object.values(value).forEach((item) => {
      if (item && typeof item === 'object') {
        freeze(item);
      }
    });
    Object.freeze(value);
  };
  freeze(cloned);
  return cloned;
};

const immutableOptions = (
  options: Readonly<PluginJsonObject> | undefined,
): Readonly<PluginJsonObject> =>
  deepFreezeJson(structuredClone(options ?? {}));

const normalizeInput = <TEvents extends object>(
  input: PluginRuntimeInput<TEvents>,
): PluginRuntimeInput<TEvents> => {
  assertPluginManifest(input.plugin.manifest);
  const manifest = deepFreezeManifest(input.plugin.manifest);
  const setup = input.plugin.setup.bind(input.plugin);
  const configuration: PluginConfiguration = Object.freeze({
    id: input.configuration.id,
    module: input.configuration.module,
    ...(input.configuration.enabled === undefined
      ? {}
      : { enabled: input.configuration.enabled }),
    ...(input.configuration.options === undefined
      ? {}
      : { options: immutableOptions(input.configuration.options) }),
    ...(input.configuration.permissions === undefined
      ? {}
      : { permissions: Object.freeze([...input.configuration.permissions]) }),
  });
  return Object.freeze({
    configuration,
    plugin: Object.freeze({ manifest, setup }),
  });
};

class WorkflowEventBus<TEvents extends object> {
  readonly #handlers = new Map<string, StoredEventHandler[]>();

  emit<TName extends WorkflowEventName<TEvents>>(
    name: TName,
    event: TEvents[TName],
  ): Promise<void> {
    return this.emitRaw(String(name), event);
  }

  emitRaw(name: string, event: unknown): Promise<void> {
    return this.#emit(name, event);
  }

  on<TName extends WorkflowEventName<TEvents>>(
    ownerId: string,
    name: TName,
    handler: WorkflowEventHandler<TEvents, TName>,
  ): PluginCleanup {
    const eventName = String(name);
    const stored: StoredEventHandler = {
      handler: handler as unknown as UntypedEventHandler,
      ownerId,
    };
    const handlers = this.#handlers.get(eventName) ?? [];
    handlers.push(stored);
    this.#handlers.set(eventName, handlers);
    return () => {
      const remaining = this.#handlers.get(eventName)?.filter((item) => item !== stored) ?? [];
      if (remaining.length === 0) {
        this.#handlers.delete(eventName);
      } else {
        this.#handlers.set(eventName, remaining);
      }
    };
  }

  async #emit(name: string, event: unknown): Promise<void> {
    // Copy before dispatch so handlers may safely subscribe/unsubscribe while emitting.
    const handlers = [...(this.#handlers.get(name) ?? [])];
    for (const { handler } of handlers) {
      await handler(event);
    }
  }
}

class ServiceRegistry {
  readonly #services = new Map<string, StoredService[]>();

  constructor(services: readonly ServiceRegistration[]) {
    services.forEach(({ service, value }) => {
      this.register(CORE_PROVIDER_ID, service, value);
    });
  }

  has(serviceId: string): boolean {
    return (this.#services.get(serviceId)?.length ?? 0) > 0;
  }

  values<TValue>(definition: ServiceDefinition<TValue>): readonly TValue[] {
    this.#assertCompatibleDefinition(definition);
    return (this.#services.get(definition.id) ?? [])
      .map(({ value }) => value as TValue);
  }

  register<TValue>(
    ownerId: string,
    definition: ServiceDefinition<TValue>,
    value: TValue,
  ): PluginCleanup {
    const current = this.#services.get(definition.id) ?? [];
    this.#assertCompatibleDefinition(definition);
    if (!definition.multiple && current.length > 0) {
      throw new Error(
        `服务 ${definition.id} 不允许多个 Provider；` +
        `已由 ${current.map(({ ownerId: currentOwner }) => currentOwner).join(', ')} 提供`,
      );
    }
    const stored: StoredService = {
      definition: definition as ServiceDefinition<unknown>,
      ownerId,
      value,
    };
    current.push(stored);
    this.#services.set(definition.id, current);
    return () => {
      const remaining = this.#services.get(definition.id)?.filter((item) => item !== stored) ?? [];
      if (remaining.length === 0) {
        this.#services.delete(definition.id);
      } else {
        this.#services.set(definition.id, remaining);
      }
    };
  }

  #assertCompatibleDefinition<TValue>(definition: ServiceDefinition<TValue>): void {
    if (!SERVICE_ID_PATTERN.test(definition.id)) {
      throw new Error(`非法插件服务标识：${definition.id}`);
    }
    const existing = this.#services.get(definition.id)?.[0]?.definition;
    if (existing &&
        (existing.multiple !== definition.multiple ||
          existing.permission !== definition.permission)) {
      throw new Error(`服务 ${definition.id} 的定义与已注册契约不一致`);
    }
  }
}

const permissionSetFor = (
  manifest: PluginManifest,
  configuration: PluginConfiguration,
): ReadonlySet<PluginPermission> => {
  const requested = new Set(manifest.permissions ?? []);
  const granted = new Set(configuration.permissions ?? []);
  const missing = [...requested].filter((permission) => !granted.has(permission));
  const unexpected = [...granted].filter((permission) => !requested.has(permission));
  if (missing.length > 0) {
    throw new Error(`插件 ${manifest.id} 缺少权限授权：${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    throw new Error(`插件 ${manifest.id} 获得了未请求权限：${unexpected.join(', ')}`);
  }
  return granted;
};

const activationOrder = <TEvents extends object>(
  inputs: readonly PluginRuntimeInput<TEvents>[],
  coreServices: readonly ServiceRegistration[],
): PluginRuntimeInput<TEvents>[] => {
  const inputById = new Map(inputs.map((input) => [input.plugin.manifest.id, input]));
  const providersByService = new Map<string, string[]>();
  coreServices.forEach(({ service }) => providersByService.set(service.id, []));
  inputs.forEach(({ plugin }) => {
    (plugin.manifest.provides?.services ?? []).forEach((serviceId) => {
      const providers = providersByService.get(serviceId) ?? [];
      providers.push(plugin.manifest.id);
      providersByService.set(serviceId, providers);
    });
  });

  const dependencies = new Map<string, Set<string>>();
  inputs.forEach(({ plugin }) => {
    const pluginDependencies = new Set(plugin.manifest.requires?.plugins ?? []);
    pluginDependencies.forEach((pluginId) => {
      if (!inputById.has(pluginId)) {
        throw new Error(`插件 ${plugin.manifest.id} 缺少插件依赖：${pluginId}`);
      }
    });
    (plugin.manifest.requires?.services ?? []).forEach((serviceId) => {
      const providers = providersByService.get(serviceId);
      if (!providers) {
        throw new Error(`插件 ${plugin.manifest.id} 缺少服务依赖：${serviceId}`);
      }
      providers.forEach((providerId) => pluginDependencies.add(providerId));
    });
    dependencies.set(plugin.manifest.id, pluginDependencies);
  });

  const dependents = new Map<string, string[]>();
  const dependencyCounts = new Map<string, number>();
  dependencies.forEach((pluginDependencies, pluginId) => {
    dependencyCounts.set(pluginId, pluginDependencies.size);
    pluginDependencies.forEach((dependencyId) => {
      const current = dependents.get(dependencyId) ?? [];
      current.push(pluginId);
      dependents.set(dependencyId, current);
    });
  });

  const ready = inputs
    .map(({ plugin }) => plugin.manifest.id)
    .filter((pluginId) => dependencyCounts.get(pluginId) === 0);
  const ordered: PluginRuntimeInput<TEvents>[] = [];
  for (let index = 0; index < ready.length; index += 1) {
    const pluginId = ready[index];
    if (!pluginId) {
      continue;
    }
    const input = inputById.get(pluginId);
    if (!input) {
      throw new Error(`插件依赖索引不一致：${pluginId}`);
    }
    ordered.push(input);
    (dependents.get(pluginId) ?? []).forEach((dependentId) => {
      const nextCount = (dependencyCounts.get(dependentId) ?? 0) - 1;
      dependencyCounts.set(dependentId, nextCount);
      if (nextCount === 0) {
        ready.push(dependentId);
      }
    });
  }
  if (ordered.length !== inputs.length) {
    const orderedIds = new Set(ordered.map(({ plugin }) => plugin.manifest.id));
    const remaining = inputs
      .map(({ plugin }) => plugin.manifest.id)
      .filter((pluginId) => !orderedIds.has(pluginId));
    throw new Error(`插件依赖存在循环：${remaining.join(', ')}`);
  }
  return ordered;
};

/**
 * Protected lifecycle engine shared by all hosts.
 *
 * Activation is atomic: a setup failure reverses the failing plugin's effects
 * and every plugin activated earlier in the same start operation.
 */
export class WorkflowPluginRuntime<TEvents extends WorkflowEventMap = WorkflowEventMap> {
  readonly #activeEffects = new Map<string, PluginCleanup[]>();
  readonly #bus = new WorkflowEventBus<TEvents>();
  readonly #inputs: readonly PluginRuntimeInput<TEvents>[];
  readonly #registry: ServiceRegistry;
  #state: PluginHostState = 'idle';

  constructor(options: PluginRuntimeOptions<TEvents> = {}) {
    const inputs = (options.plugins ?? []).map(normalizeInput);
    const ids = inputs.map(({ plugin }) => plugin.manifest.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error('插件 id 不能重复');
    }
    inputs.forEach(({ configuration, plugin }) => {
      if (configuration.id !== plugin.manifest.id) {
        throw new Error(
          `插件配置 id ${configuration.id} 与 Manifest ${plugin.manifest.id} 不一致`,
        );
      }
      permissionSetFor(plugin.manifest, configuration);
    });
    const coreServices = options.services ?? [];
    this.#registry = new ServiceRegistry(coreServices);
    this.#inputs = activationOrder(inputs, coreServices);
  }

  get state(): PluginHostState {
    return this.#state;
  }

  getService<TValue>(service: ServiceDefinition<TValue>): TValue {
    const values = this.#registry.values(service);
    if (values.length === 0) {
      throw new Error(`服务尚未注册：${service.id}`);
    }
    if (values.length > 1) {
      throw new Error(`服务 ${service.id} 有多个 Provider，请使用 getServices`);
    }
    return values[0] as TValue;
  }

  getServices<TValue>(service: ServiceDefinition<TValue>): readonly TValue[] {
    return this.#registry.values(service);
  }

  /** Publishes a protected-core event to active plugins in deterministic order. */
  emit<TName extends WorkflowEventName<TEvents>>(
    name: TName,
    event: TEvents[TName],
  ): Promise<void> {
    if (this.#state !== 'running') {
      throw new Error(`插件宿主只能在 running 状态发布事件，当前为 ${this.#state}`);
    }
    return this.#bus.emit(name, event);
  }

  status(): readonly PluginStatus[] {
    return this.#inputs.map(({ plugin }) => ({
      capabilities: plugin.manifest.capabilities,
      id: plugin.manifest.id,
      state: this.#activeEffects.has(plugin.manifest.id) ? 'active' : 'inactive',
      version: plugin.manifest.version,
    }));
  }

  async start(): Promise<void> {
    if (this.#state !== 'idle') {
      throw new Error(`插件宿主不能从 ${this.#state} 状态启动`);
    }
    this.#state = 'starting';
    try {
      for (const input of this.#inputs) {
        await this.#activate(input);
      }
      this.#state = 'running';
    } catch (error: unknown) {
      const rollbackErrors = await this.#deactivateAll();
      this.#state = 'idle';
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], '插件启动失败且回滚不完整');
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === 'idle') {
      return;
    }
    if (this.#state !== 'running') {
      throw new Error(`插件宿主不能从 ${this.#state} 状态停止`);
    }
    this.#state = 'stopping';
    const errors = await this.#deactivateAll();
    this.#state = 'idle';
    if (errors.length > 0) {
      throw new AggregateError(errors, '一个或多个插件清理失败');
    }
  }

  async #activate(input: PluginRuntimeInput<TEvents>): Promise<void> {
    const { configuration, plugin } = input;
    const { manifest } = plugin;
    const effects: PluginCleanup[] = [];
    const grantedPermissions = permissionSetFor(manifest, configuration);
    const event = Object.freeze({ pluginId: manifest.id });
    await this.#bus.emitRaw('plugin:activating', event);
    const context = this.#contextFor(input, effects, grantedPermissions);
    try {
      const cleanup = await plugin.setup(context);
      if (cleanup) {
        effects.push(cleanup);
      }
      await this.#bus.emitRaw('plugin:activated', event);
      this.#activeEffects.set(manifest.id, effects);
    } catch (error: unknown) {
      const cleanupErrors = await this.#runCleanups(effects);
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], `插件 ${manifest.id} 激活回滚失败`);
      }
      throw error;
    }
  }

  #contextFor(
    input: PluginRuntimeInput<TEvents>,
    effects: PluginCleanup[],
    grantedPermissions: ReadonlySet<PluginPermission>,
  ): PluginContext<TEvents> {
    const { configuration, plugin } = input;
    const { manifest } = plugin;
    const requiredServices = new Set(manifest.requires?.services ?? []);
    const providedServices = new Set(manifest.provides?.services ?? []);

    const assertCanResolve = <TValue>(service: ServiceDefinition<TValue>): void => {
      if (!requiredServices.has(service.id)) {
        throw new Error(`插件 ${manifest.id} 未在 requires.services 声明 ${service.id}`);
      }
      if (service.permission && !grantedPermissions.has(service.permission)) {
        throw new Error(`插件 ${manifest.id} 无权访问服务 ${service.id}`);
      }
    };
    const resolveAll = <TValue>(service: ServiceDefinition<TValue>): readonly TValue[] => {
      assertCanResolve(service);
      return this.#registry.values(service);
    };

    return Object.freeze({
      effect: async (setup: () => Promise<PluginCleanup | void> | PluginCleanup | void) => {
        const cleanup = await setup();
        if (cleanup) {
          effects.push(cleanup);
        }
      },
      emit: <TName extends WorkflowEventName<TEvents>>(
        name: TName,
        event: TEvents[TName],
      ) => this.#bus.emit(name, event),
      get: <TValue>(service: ServiceDefinition<TValue>): TValue => {
        const values = resolveAll(service);
        if (values.length === 0) {
          throw new Error(`插件 ${manifest.id} 依赖的服务尚未注册：${service.id}`);
        }
        if (values.length > 1) {
          throw new Error(`服务 ${service.id} 有多个 Provider，请使用 getAll`);
        }
        return values[0] as TValue;
      },
      getAll: resolveAll,
      getOptional: <TValue>(service: ServiceDefinition<TValue>): TValue | undefined => {
        const values = resolveAll(service);
        if (values.length > 1) {
          throw new Error(`服务 ${service.id} 有多个 Provider，请使用 getAll`);
        }
        return values[0];
      },
      grantedPermissions,
      manifest,
      on: <TName extends WorkflowEventName<TEvents>>(
        name: TName,
        handler: WorkflowEventHandler<TEvents, TName>,
      ) => {
        effects.push(this.#bus.on(manifest.id, name, handler));
      },
      options: immutableOptions(configuration.options),
      provide: <TValue>(service: ServiceDefinition<TValue>, value: TValue) => {
        if (!providedServices.has(service.id)) {
          throw new Error(`插件 ${manifest.id} 未在 provides.services 声明 ${service.id}`);
        }
        effects.push(this.#registry.register(manifest.id, service, value));
      },
    });
  }

  async #deactivateAll(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const input of [...this.#inputs].reverse()) {
      if (!this.#activeEffects.has(input.plugin.manifest.id)) {
        continue;
      }
      try {
        await this.#deactivate(input.plugin.manifest.id);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    return errors;
  }

  async #deactivate(pluginId: string): Promise<void> {
    const effects = this.#activeEffects.get(pluginId) ?? [];
    const errors: unknown[] = [];
    const event = Object.freeze({ pluginId });
    try {
      await this.#bus.emitRaw('plugin:deactivating', event);
    } catch (error: unknown) {
      errors.push(error);
    }
    errors.push(...await this.#runCleanups(effects));
    this.#activeEffects.delete(pluginId);
    try {
      await this.#bus.emitRaw('plugin:deactivated', event);
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `插件 ${pluginId} 清理失败`);
    }
  }

  async #runCleanups(effects: readonly PluginCleanup[]): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const cleanup of [...effects].reverse()) {
      try {
        await cleanup();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    return errors;
  }
}
