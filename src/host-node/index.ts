import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  PluginConfiguration,
  ServiceRegistration,
  WorkflowEventMap,
  WorkflowPlugin,
} from '../contracts/plugin.js';
import { assertPluginManifest, WorkflowPluginRuntime } from '../core/plugin-runtime.js';
import type { WorkflowConfig } from '../types/contracts.js';

export { assertPluginManifest, WorkflowPluginRuntime } from '../core/plugin-runtime.js';
export type { PluginRuntimeInput, PluginRuntimeOptions } from '../core/plugin-runtime.js';

const PACKAGE_SPECIFIER_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[^\\]+)?$/;

interface PackageMetadata {
  name?: unknown;
  exports?: unknown;
  main?: unknown;
  module?: unknown;
}

const packageParts = (specifier: string): { name: string; subpath: string } => {
  const segments = specifier.split('/');
  const nameLength = specifier.startsWith('@') ? 2 : 1;
  return {
    name: segments.slice(0, nameLength).join('/'),
    subpath: segments.slice(nameLength).join('/'),
  };
};

const selectImportTarget = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = selectImportTarget(candidate);
      if (selected) {
        return selected;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const conditions = value as Record<string, unknown>;
  for (const condition of ['node', 'import', 'default']) {
    if (Object.hasOwn(conditions, condition)) {
      const selected = selectImportTarget(conditions[condition]);
      if (selected) {
        return selected;
      }
    }
  }
  return undefined;
};

/** Resolves the import condition from a direct workspace dependency. */
const resolvePackageImport = (specifier: string, workspaceRoot: string): string => {
  const { name, subpath } = packageParts(specifier);
  const dependencyDirectory = path.join(workspaceRoot, 'node_modules', ...name.split('/'));
  const dependencyMetadataPath = path.join(dependencyDirectory, 'package.json');
  const workspaceMetadataPath = path.join(workspaceRoot, 'package.json');
  let packageDirectory = dependencyDirectory;
  let metadataPath = dependencyMetadataPath;
  if (!existsSync(dependencyMetadataPath) && existsSync(workspaceMetadataPath)) {
    const workspaceMetadata = JSON.parse(
      readFileSync(workspaceMetadataPath, 'utf8'),
    ) as PackageMetadata;
    if (workspaceMetadata.name === name) {
      packageDirectory = workspaceRoot;
      metadataPath = workspaceMetadataPath;
    }
  }
  if (!existsSync(metadataPath)) {
    const requireFromWorkspace = createRequire(path.join(workspaceRoot, 'package.json'));
    return requireFromWorkspace.resolve(specifier);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as PackageMetadata;
  const exportKey = subpath ? `./${subpath}` : '.';
  let exportValue: unknown;
  if (typeof metadata.exports === 'string' || Array.isArray(metadata.exports)) {
    exportValue = subpath ? undefined : metadata.exports;
  } else if (metadata.exports && typeof metadata.exports === 'object') {
    const exportsMap = metadata.exports as Record<string, unknown>;
    const hasSubpathKeys = Object.keys(exportsMap).some((key) => key.startsWith('.'));
    exportValue = hasSubpathKeys ? exportsMap[exportKey] : subpath ? undefined : exportsMap;
  }
  const selectedExport = selectImportTarget(exportValue);
  if (metadata.exports !== undefined && !selectedExport) {
    throw new Error(`插件包 ${name} 未导出 ${exportKey}`);
  }
  const legacyTarget = subpath ||
    (typeof metadata.module === 'string' ? metadata.module : undefined) ||
    (typeof metadata.main === 'string' ? metadata.main : undefined) ||
    'index.js';
  const selected = selectedExport ?? (
    legacyTarget.startsWith('./') ? legacyTarget : `./${legacyTarget}`
  );
  if (!selected.startsWith('./')) {
    throw new Error(`插件包 ${name} 的导出目标必须位于包内：${selected}`);
  }
  const resolved = path.resolve(packageDirectory, selected);
  const packagePrefix = `${path.resolve(packageDirectory)}${path.sep}`;
  if (!resolved.startsWith(packagePrefix)) {
    throw new Error(`插件包 ${name} 的导出目标越出包目录`);
  }
  return resolved;
};

const resolveWorkspaceModule = (specifier: string, workspaceRoot: string): string => {
  if (!specifier || path.isAbsolute(specifier) || /^[a-z][a-z+.-]*:/i.test(specifier)) {
    throw new Error(`插件 module 必须是包名或工作区相对路径：${specifier}`);
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const resolved = path.resolve(workspaceRoot, specifier);
    const workspaceResolvedPath = path.resolve(workspaceRoot);
    const workspaceResolvedPrefix = `${workspaceResolvedPath}${path.sep}`;
    if (!resolved.startsWith(workspaceResolvedPrefix)) {
      throw new Error(`插件 module 不能越出工作区：${specifier}`);
    }
    const workspaceRealPath = realpathSync(workspaceRoot);
    if (!existsSync(resolved)) {
      throw new Error(`插件 module 不存在：${specifier}`);
    }
    const resolvedRealPath = realpathSync(resolved);
    const workspacePrefix = `${workspaceRealPath}${path.sep}`;
    if (!resolvedRealPath.startsWith(workspacePrefix)) {
      throw new Error(`插件 module 不能越出工作区：${specifier}`);
    }
    return resolvedRealPath;
  }
  if (!PACKAGE_SPECIFIER_PATTERN.test(specifier)) {
    throw new Error(`插件包名非法：${specifier}`);
  }
  return resolvePackageImport(specifier, workspaceRoot);
};

const pluginFromModule = <TEvents extends object>(
  moduleNamespace: unknown,
  specifier: string,
): WorkflowPlugin<TEvents> => {
  if (!moduleNamespace || typeof moduleNamespace !== 'object' ||
      !Object.hasOwn(moduleNamespace, 'default')) {
    throw new Error(`插件 ${specifier} 必须提供 default export`);
  }
  const candidate = (moduleNamespace as { default: unknown }).default;
  if (!candidate || typeof candidate !== 'object' ||
      !Object.hasOwn(candidate, 'manifest') ||
      typeof (candidate as { setup?: unknown }).setup !== 'function') {
    throw new Error(`插件 ${specifier} 的 default export 不符合 WorkflowPlugin 契约`);
  }
  const plugin = candidate as { manifest: unknown; setup: WorkflowPlugin<TEvents>['setup'] };
  assertPluginManifest(plugin.manifest);
  return plugin as WorkflowPlugin<TEvents>;
};

/** Loads trusted ESM plugins from the consuming workspace in declaration order. */
export const loadNodePlugins = async <TEvents extends WorkflowEventMap = WorkflowEventMap>(
  configurations: readonly PluginConfiguration[],
  workspaceRoot: string,
): Promise<readonly {
  configuration: PluginConfiguration;
  plugin: WorkflowPlugin<TEvents>;
}[]> => {
  const enabled = configurations.filter(({ enabled = true }) => enabled);
  const loaded: {
    configuration: PluginConfiguration;
    plugin: WorkflowPlugin<TEvents>;
  }[] = [];
  for (const configuration of enabled) {
    const resolvedModule = resolveWorkspaceModule(configuration.module, workspaceRoot);
    const moduleNamespace: unknown = await import(pathToFileURL(resolvedModule).href);
    const plugin = pluginFromModule<TEvents>(moduleNamespace, configuration.module);
    if (plugin.manifest.id !== configuration.id) {
      throw new Error(
        `插件配置 id ${configuration.id} 与模块 Manifest ${plugin.manifest.id} 不一致`,
      );
    }
    loaded.push({ configuration, plugin });
  }
  return loaded;
};

export interface CreateNodePluginHostOptions {
  readonly services?: readonly ServiceRegistration[];
  readonly workspaceRoot: string;
}

/** Creates the Node host without activating plugins, allowing callers to add gates first. */
export const createNodePluginHost = async <
  TEvents extends WorkflowEventMap = WorkflowEventMap,
>(
  config: WorkflowConfig,
  options: CreateNodePluginHostOptions,
): Promise<WorkflowPluginRuntime<TEvents>> => {
  const plugins = await loadNodePlugins<TEvents>(config.plugins ?? [], options.workspaceRoot);
  return new WorkflowPluginRuntime<TEvents>({
    plugins,
    ...(options.services ? { services: options.services } : {}),
  });
};
