import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  workflowConfigPath,
  workflowRoot,
  workspaceRoot,
} from './workspace-paths.js';
import type {
  UnknownRecord,
  WorkflowConfig,
  WorkflowPathKey,
  WorkflowPaths,
  WorkflowProfile,
} from '../types/contracts.js';
import {
  errorMessage,
  isJsonObject,
  isUniqueStringArray,
} from '../types/guards.js';
import { PLUGIN_PERMISSIONS } from '../contracts/plugin.js';
import type { PluginPermission } from '../contracts/plugin.js';

export { workflowConfigPath };

const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELATIVE_PATH_FIELDS: WorkflowPathKey[] = [
  'knowledgeRoot',
  'runtimeRoot',
  'skillsRoot',
  'tasksRoot',
];
const WORKFLOW_LOCATOR_PREFIX = 'workflow:';

const stringArrayProperty = (value: UnknownRecord, key: string): string[] =>
  isUniqueStringArray(value[key]) ? value[key] : [];

const stringMapProperty = (value: UnknownRecord, key: string): Record<string, string> => {
  const candidate = value[key];
  if (!isJsonObject(candidate)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(candidate).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string'),
  );
};

/** Resolves a declared path while enforcing the workspace containment boundary. */
export const resolveWorkspaceRelativePath = (
  relativePath: unknown,
  label = 'path',
): string => {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${label} 必须是非空工作区相对路径`);
  }
  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  const workspacePrefix = `${workspaceRoot}${path.sep}`;
  if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(workspacePrefix)) {
    throw new Error(`${label} 不能越出工作区：${relativePath}`);
  }
  return resolvedPath;
};

/** Resolves either a workspace path or a package-owned `workflow:` locator. */
export const resolveWorkflowLocator = (locator: unknown, label = 'path'): string => {
  if (typeof locator !== 'string' || !locator) {
    throw new Error(`${label} 必须是非空路径定位符`);
  }
  if (!locator.startsWith(WORKFLOW_LOCATOR_PREFIX)) {
    return resolveWorkspaceRelativePath(locator, label);
  }

  const relativePath = locator.slice(WORKFLOW_LOCATOR_PREFIX.length);
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${label} 的 workflow: 路径非法：${locator}`);
  }
  const resolvedPath = path.resolve(workflowRoot, relativePath);
  const workflowPrefix = `${workflowRoot}${path.sep}`;
  if (resolvedPath === workflowRoot || !resolvedPath.startsWith(workflowPrefix)) {
    throw new Error(`${label} 不能越出工作流包：${locator}`);
  }
  return resolvedPath;
};

const readJson = (filePath: string, label: string): unknown => {
  if (!existsSync(filePath)) {
    throw new Error(`${label} 不存在：${path.relative(workspaceRoot, filePath)}`);
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error: unknown) {
    throw new Error(`${label} 不是合法 JSON：${errorMessage(error)}`);
  }
};

/** Validates the host-owned profile selection and portable runtime paths. */
export const validateWorkflowConfig = (config: unknown): string[] => {
  const errors: string[] = [];
  if (!isJsonObject(config)) {
    return ['workflow.config.json 必须是对象'];
  }
  if (config.schemaVersion !== 1) {
    errors.push('workflow.config.json schemaVersion 必须为 1');
  }
  if (typeof config.activeProfile !== 'string' || !config.activeProfile) {
    errors.push('workflow.config.json 缺少 activeProfile');
  } else {
    try {
      resolveWorkflowLocator(config.activeProfile, 'activeProfile');
    } catch (error: unknown) {
      errors.push(errorMessage(error));
    }
  }
  if (!isJsonObject(config.paths)) {
    errors.push('workflow.config.json 缺少 paths');
  } else {
    const configuredPaths = config.paths;
    const resolvedPaths = new Map<WorkflowPathKey, string>();
    RELATIVE_PATH_FIELDS.forEach((field) => {
      try {
        const resolvedPath = resolveWorkspaceRelativePath(
          configuredPaths[field],
          `paths.${field}`,
        );
        if (resolvedPath === workspaceRoot) {
          errors.push(`paths.${field} 不能指向工作区根目录`);
        }
        const duplicateField = [...resolvedPaths.entries()]
          .find(([, candidate]) => candidate === resolvedPath)?.[0];
        if (duplicateField) {
          errors.push(`paths.${field} 不能与 paths.${duplicateField} 相同`);
        }
        resolvedPaths.set(field, resolvedPath);
      } catch (error: unknown) {
        errors.push(errorMessage(error));
      }
    });
  }
  if (config.plugins !== undefined) {
    if (!Array.isArray(config.plugins)) {
      errors.push('workflow.config.json plugins 必须是数组');
    } else {
      const pluginIds = new Set<string>();
      config.plugins.forEach((plugin, index) => {
        const label = `plugins[${index}]`;
        if (!isJsonObject(plugin)) {
          errors.push(`${label} 必须是对象`);
          return;
        }
        const pluginId = typeof plugin.id === 'string' ? plugin.id : '';
        if (!IDENTIFIER_PATTERN.test(pluginId)) {
          errors.push(`${label}.id 只能包含小写字母、数字和连字符`);
        } else if (pluginIds.has(pluginId)) {
          errors.push(`${label}.id 不能重复：${pluginId}`);
        } else {
          pluginIds.add(pluginId);
        }
        if (typeof plugin.module !== 'string' || !plugin.module.trim()) {
          errors.push(`${label}.module 必须是非空字符串`);
        }
        if (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean') {
          errors.push(`${label}.enabled 必须是布尔值`);
        }
        if (plugin.options !== undefined && !isJsonObject(plugin.options)) {
          errors.push(`${label}.options 必须是 JSON 对象`);
        }
        if (plugin.permissions !== undefined) {
          if (!isUniqueStringArray(plugin.permissions)) {
            errors.push(`${label}.permissions 必须是不重复的字符串数组`);
          } else if (plugin.permissions.some((permission) =>
            !PLUGIN_PERMISSIONS.includes(permission as PluginPermission))) {
            errors.push(`${label}.permissions 包含未知权限`);
          }
        }
      });
    }
  }
  return errors;
};

/** Loads the host configuration only after its path and shape gates pass. */
export const loadWorkflowConfig = (filePath = workflowConfigPath): WorkflowConfig => {
  const config = readJson(filePath, '工作流配置');
  const errors = validateWorkflowConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }
  return config as WorkflowConfig;
};

const validateStringMap = (
  value: unknown,
  label: string,
  errors: string[],
): void => {
  if (!isJsonObject(value)) {
    errors.push(`${label} 必须是对象`);
    return;
  }
  Object.entries(value).forEach(([key, item]) => {
    if (!IDENTIFIER_PATTERN.test(key) || typeof item !== 'string' || !item) {
      errors.push(`${label} 包含非法映射：${key}`);
    }
  });
};

/** Validates project vocabulary and bindings without executing those bindings. */
export const validateWorkflowProfile = (profile: unknown): string[] => {
  const errors: string[] = [];
  if (!isJsonObject(profile)) {
    return ['Workflow Profile 必须是对象'];
  }
  if (profile.schemaVersion !== 1) {
    errors.push('Workflow Profile schemaVersion 必须为 1');
  }
  if (!IDENTIFIER_PATTERN.test(typeof profile.id === 'string' ? profile.id : '')) {
    errors.push('Workflow Profile id 只能包含小写字母、数字和连字符');
  }

  const taskModel = profile.taskModel;
  if (!isJsonObject(taskModel)) {
    errors.push('Workflow Profile 缺少 taskModel');
  } else {
    if (!isJsonObject(taskModel.intentRoutes)) {
      errors.push('taskModel.intentRoutes 必须是对象');
    } else {
      Object.entries(taskModel.intentRoutes).forEach(([intent, target]) => {
        const validTarget = target === null ||
          (Array.isArray(target) && target.length === 2 &&
            target.every((item) => typeof item === 'string' && item));
        if (!IDENTIFIER_PATTERN.test(intent) || !validTarget) {
          errors.push(`taskModel.intentRoutes 包含非法路由：${intent}`);
        }
      });
    }
    const identifierArrayFields = [
      'artifactEntryModes',
      'changeEntryModes',
      'changeIntents',
      'changeTypes',
      'evolutionaryChangeTypes',
      'knownStages',
      'sourceTypes',
    ] as const;
    identifierArrayFields.forEach((field) => {
      if (!isUniqueStringArray(taskModel[field])) {
        errors.push(`taskModel.${field} 必须是不重复的字符串数组`);
      }
    });
    const strictIdentifierArrayFields = [
      'artifactEntryModes',
      'changeEntryModes',
      'changeIntents',
      'changeTypes',
      'evolutionaryChangeTypes',
      'sourceTypes',
    ] as const;
    strictIdentifierArrayFields.forEach((field) => {
      stringArrayProperty(taskModel, field).forEach((value) => {
        if (!IDENTIFIER_PATTERN.test(value)) {
          errors.push(`taskModel.${field} 包含非法标识：${value}`);
        }
      });
    });
    validateStringMap(taskModel.changeTypeByIntent, 'taskModel.changeTypeByIntent', errors);
    validateStringMap(taskModel.microStages, 'taskModel.microStages', errors);
    if (!isJsonObject(taskModel.expectedIntentEntries)) {
      errors.push('taskModel.expectedIntentEntries 必须是对象');
    }
    ['providerEntryMode', 'sourceCaptureStage', 'intakeStage'].forEach((field) => {
      if (typeof taskModel[field] !== 'string' || !taskModel[field]) {
        errors.push(`taskModel.${field} 必须是非空字符串`);
      }
    });
    if (isUniqueStringArray(taskModel.changeTypes)) {
      const changeTypes = new Set(taskModel.changeTypes);
      stringArrayProperty(taskModel, 'evolutionaryChangeTypes').forEach((changeType) => {
        if (!changeTypes.has(changeType)) {
          errors.push(`evolutionaryChangeTypes 包含未知 changeType：${changeType}`);
        }
      });
      Object.values(stringMapProperty(taskModel, 'changeTypeByIntent')).forEach((changeType) => {
        if (!changeTypes.has(changeType)) {
          errors.push(`changeTypeByIntent 映射到未知 changeType：${changeType}`);
        }
      });
      const microStages = stringMapProperty(taskModel, 'microStages');
      taskModel.changeTypes.forEach((changeType) => {
        if (!microStages[changeType]) {
          errors.push(`microStages 缺少 changeType：${changeType}`);
        }
      });
    }
    const intentRoutes = isJsonObject(taskModel.intentRoutes) ? taskModel.intentRoutes : {};
    stringArrayProperty(taskModel, 'changeIntents').forEach((intent) => {
      if (!Object.hasOwn(intentRoutes, intent) || intentRoutes[intent] !== null) {
        errors.push(`change intent 必须在 intentRoutes 中声明为 null：${intent}`);
      }
    });
    if (isJsonObject(taskModel.expectedIntentEntries)) {
      Object.entries(taskModel.expectedIntentEntries).forEach(([intent, entries]) => {
        if (!isUniqueStringArray(entries)) {
          errors.push(`expectedIntentEntries.${intent} 必须是不重复的字符串数组`);
        }
      });
    }
  }

  if (!isJsonObject(profile.sourceProviders)) {
    errors.push('Workflow Profile 缺少 sourceProviders');
  } else {
    Object.entries(profile.sourceProviders).forEach(([entry, binding]) => {
      if (!IDENTIFIER_PATTERN.test(entry) || !isJsonObject(binding) ||
          !IDENTIFIER_PATTERN.test(typeof binding?.kind === 'string' ? binding.kind : '')) {
        errors.push(`sourceProviders 包含非法绑定：${entry}`);
        return;
      }
      if (binding.kind !== 'conversation' &&
          (typeof binding.name !== 'string' || !binding.name)) {
        errors.push(`sourceProviders.${entry} 缺少 name`);
      }
    });
  }
  if (!isJsonObject(profile.review) || typeof profile.review.defaultSkill !== 'string' ||
      (profile.review.defaultSkill &&
        !IDENTIFIER_PATTERN.test(profile.review.defaultSkill))) {
    errors.push('Workflow Profile review.defaultSkill 必须是字符串');
  }
  if (!isJsonObject(profile.issueTracking) ||
      typeof profile.issueTracking.enabled !== 'boolean') {
    errors.push('Workflow Profile 缺少 issueTracking');
  } else {
    const issueTracking = profile.issueTracking;
    if (!isUniqueStringArray(issueTracking.requiredForTypes)) {
      errors.push('issueTracking.requiredForTypes 必须是不重复的字符串数组');
    }
    const issueStringFields = ['pattern', 'flags', 'enforceEnvironment', 'label'] as const;
    issueStringFields.forEach((field) => {
      if (typeof issueTracking[field] !== 'string') {
        errors.push(`issueTracking.${field} 必须是字符串`);
      }
    });
    if (issueTracking.enabled) {
      const pattern = typeof issueTracking.pattern === 'string' ? issueTracking.pattern : '';
      const flags = typeof issueTracking.flags === 'string' ? issueTracking.flags : '';
      try {
        new RegExp(pattern, flags);
      } catch (error: unknown) {
        errors.push(`issueTracking.pattern 非法：${errorMessage(error)}`);
      }
      if (!issueTracking.label) {
        errors.push('issueTracking.label 不能为空');
      }
    }
  }
  if (!isJsonObject(profile.evals) || typeof profile.evals.routeCases !== 'string') {
    errors.push('Workflow Profile 缺少 evals.routeCases');
  } else {
    try {
      resolveWorkflowLocator(profile.evals.routeCases, 'evals.routeCases');
    } catch (error: unknown) {
      errors.push(errorMessage(error));
    }
  }
  ['governance', 'setup'].forEach((section) => {
    if (!isJsonObject(profile[section])) {
      errors.push(`Workflow Profile 缺少 ${section}`);
    }
  });
  if (isJsonObject(profile.governance)) {
    const governance = profile.governance;
    const governanceArrayFields = [
      'requiredPaths',
      'markdownFiles',
      'markdownRoots',
      'denyEagerDocs',
      'forbiddenStagedPatterns',
      'deprecatedReferences',
    ] as const;
    governanceArrayFields.forEach((field) => {
        if (!isUniqueStringArray(governance[field])) {
          errors.push(`governance.${field} 必须是不重复的字符串数组`);
        }
      });
    stringArrayProperty(governance, 'forbiddenStagedPatterns').forEach((pattern) => {
      try {
        new RegExp(pattern, 'i');
      } catch (error: unknown) {
        errors.push(`governance.forbiddenStagedPatterns 非法：${errorMessage(error)}`);
      }
    });
    const governancePathFields = [
      'requiredPaths',
      'markdownFiles',
      'markdownRoots',
      'denyEagerDocs',
    ] as const;
    governancePathFields.forEach((field) => {
      stringArrayProperty(governance, field).forEach((relativePath) => {
        try {
          resolveWorkspaceRelativePath(relativePath, `governance.${field}`);
        } catch (error: unknown) {
          errors.push(errorMessage(error));
        }
      });
    });
  }
  if (isJsonObject(profile.setup)) {
    const setup = profile.setup;
    if (!isUniqueStringArray(setup.requiredPaths)) {
      errors.push('setup.requiredPaths 必须是不重复的字符串数组');
    }
    stringArrayProperty(setup, 'requiredPaths').forEach((relativePath) => {
      try {
        resolveWorkspaceRelativePath(relativePath, 'setup.requiredPaths');
      } catch (error: unknown) {
        errors.push(errorMessage(error));
      }
    });
  }
  return errors;
};

/** Loads a workspace-contained Profile and rejects invalid project bindings. */
export const loadWorkflowProfile = (profilePath: string): WorkflowProfile => {
  const resolvedPath = resolveWorkflowLocator(profilePath, 'activeProfile');
  const profile = readJson(resolvedPath, 'Workflow Profile');
  const errors = validateWorkflowProfile(profile);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }
  return profile as WorkflowProfile;
};

/** Returns the configured Profile, with an explicit process-local migration override. */
export const activeProfilePathFor = (config = loadWorkflowConfig()): string =>
  process.env.AI_WORKFLOW_PROFILE?.trim() || config.activeProfile;

/** Loads the Profile that controls the current process. */
export const loadActiveProfile = (config = loadWorkflowConfig()): WorkflowProfile =>
  loadWorkflowProfile(activeProfilePathFor(config));

/** Resolves all configured runtime roots to workspace-contained absolute paths. */
export const loadWorkflowPaths = (config = loadWorkflowConfig()): WorkflowPaths =>
  ({
    ...Object.fromEntries(
      Object.entries(config.paths).map(([key, relativePath]) => [
        key,
        resolveWorkspaceRelativePath(relativePath, `paths.${key}`),
      ]),
    ),
    routes: path.join(workflowRoot, 'resources', 'routes.json'),
  }) as WorkflowPaths;

/** Builds a normalized workspace-relative path below a configured runtime root. */
export const workflowRelativePath = (
  pathKey: WorkflowPathKey,
  ...segments: string[]
): string => {
  const config = loadWorkflowConfig();
  const basePath = config.paths[pathKey];
  if (typeof basePath !== 'string') {
    throw new Error(`未知工作流路径键：${pathKey}`);
  }
  const relativePath = path.posix.join(
    basePath.replaceAll('\\', '/'),
    ...segments,
  );
  resolveWorkspaceRelativePath(relativePath, `paths.${pathKey}`);
  return relativePath;
};

/** Produces the minimal non-sensitive Profile binding shown in Route Packets. */
export const describeProfileBinding = (profile: WorkflowProfile, entry: string) => {
  const sourceProvider = profile.sourceProviders?.[entry];
  return {
    id: profile.id,
    reviewSkill: profile.review?.defaultSkill || 'none',
    sourceProvider: sourceProvider?.name || sourceProvider?.kind || 'none',
  };
};
