import {
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { workflowRoot, workspaceRoot } from '../config/workspace-paths.js';
import {
  describeProfileBinding,
  loadActiveProfile,
  loadWorkflowPaths,
  resolveWorkflowLocator,
} from '../config/workflow-config.js';
import type {
  MicroBriefSummary,
  MicroGuardSummary,
  RepositoryBinding,
  RouteClassification,
  RoutePacket,
  RoutePacketBase,
  RoutesConfig,
} from '../types/contracts.js';
import { errorMessage } from '../types/guards.js';

export { workspaceRoot };
export const routesPath = loadWorkflowPaths().routes;
const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_ID_PATTERN = /^run-[a-z0-9]{16,64}$/;
const MAX_PACKET_RESERVE_PASSES = 4;

export interface BuildRoutePacketOptions {
  classification?: RouteClassification | null;
  entry: string;
  microBrief?: MicroBriefSummary | null;
  microGuard?: MicroGuardSummary | null;
  microRepository?: RepositoryBinding | null;
  parentRunId?: string;
  references?: string[];
  riskFlags?: string[];
  route: string;
  runId?: string;
  skills?: string[];
  stage: string;
  taskId?: string;
}

interface MarkdownHeading {
  index: number;
  level: number;
  slug: string;
}

interface RouteValidationResult {
  alwaysOnChars: number;
  alwaysOnLimit: number;
  errors: string[];
  knownPaths: string[];
  routeSummaries: Array<{
    budgetChars: number;
    projectedChars: number;
    route: string;
    stage: string;
  }>;
}

interface MaterializedDocument {
  content: string;
  path: string;
}

interface MaterializationResult {
  complete: boolean;
  materializedDocs: string[];
  omittedDocs: string[];
  output: string;
  outputChars: number;
  requestedOutputChars: number;
}

const toDisplayPath = (filePath: string): string =>
  path.relative(workspaceRoot, filePath).split(path.sep).join('/');

const splitDocumentSelector = (selector: string) => {
  if (typeof selector !== 'string' || !selector) {
    throw new Error(`工作流路径必须是非空相对路径：${selector || '空'}`);
  }
  const fragmentIndex = selector.indexOf('#');
  if (fragmentIndex < 0) {
    return {
      fragment: '',
      relativePath: selector,
    };
  }
  const relativePath = selector.slice(0, fragmentIndex);
  const fragment = selector.slice(fragmentIndex + 1);
  if (!relativePath || !fragment || fragment.includes('#')) {
    throw new Error(`工作流文档选择器非法：${selector}`);
  }
  return {
    fragment,
    relativePath,
  };
};

const selectorFilePath = (selector: string): string => {
  const { relativePath } = splitDocumentSelector(selector);
  const resolvedPath = resolveWorkflowLocator(relativePath, '工作流文档');
  return existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;
};

const isPathInside = (candidatePath: string, rootPath: string): boolean => {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath);
};

const headingSlug = (value: string): string => value
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/[`*_~]/g, '')
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '');

const readMarkdownSection = (
  content: string,
  fragment: string,
  selector: string,
): string => {
  const targetSlug = headingSlug(fragment);
  if (!targetSlug) {
    throw new Error(`Markdown 章节标识非法：${selector}`);
  }
  const lines = content.split(/\r?\n/);
  const headings: MarkdownHeading[] = [];
  let fence: { character: string; length: number } | null = null;

  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!marker) {
        return;
      }
      if (!fence) {
        fence = {
          character: marker[0] ?? '',
          length: marker.length,
        };
      } else if (marker[0] === fence.character &&
                 marker.length >= fence.length) {
        fence = null;
      }
      return;
    }
    if (fence) {
      return;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      headings.push({
        index,
        level: heading[1]?.length ?? 0,
        slug: headingSlug(heading[2] ?? ''),
      });
    }
  });

  const matches = headings.filter(({ slug }) => slug === targetSlug);
  if (matches.length === 0) {
    throw new Error(`Markdown 章节不存在：${selector}`);
  }
  if (matches.length > 1) {
    throw new Error(`Markdown 章节标识不唯一：${selector}`);
  }
  const selected = matches[0];
  if (!selected) {
    throw new Error(`Markdown 章节不存在：${selector}`);
  }
  const nextHeading = headings.find(({ index, level }) =>
    index > selected.index && level <= selected.level);
  return lines
    .slice(selected.index, nextHeading?.index ?? lines.length)
    .join('\n')
    .trimEnd();
};

export const readWorkspaceText = (selector: string): string => {
  const { fragment, relativePath } = splitDocumentSelector(selector);
  const resolvedPath = resolveWorkflowLocator(relativePath, '工作流文档');
  if (!existsSync(resolvedPath)) {
    throw new Error(`工作流文件不存在：${relativePath}`);
  }
  const content = readFileSync(resolvedPath, 'utf8');
  return fragment
    ? readMarkdownSection(content, fragment, selector)
    : content;
};

export const readCharacterCount = (selector: string): number =>
  Array.from(readWorkspaceText(selector)).length;

export const loadRoutes = (): RoutesConfig => {
  if (!existsSync(routesPath)) {
    throw new Error('agent-workflow/resources/routes.json 不存在');
  }

  let config: RoutesConfig;
  try {
    config = JSON.parse(readFileSync(routesPath, 'utf8')) as RoutesConfig;
  } catch (error: unknown) {
    throw new Error(`无法解析 routes.json：${errorMessage(error)}`);
  }
  const profile = loadActiveProfile();
  return {
    ...config,
    denyEagerDocs: [
      ...new Set([
        ...(config.denyEagerDocs || []),
        ...(profile.governance.denyEagerDocs || []),
      ]),
    ],
  };
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const resolveSkill = (skillName: string): string => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error(`Skill 名称非法：${skillName}`);
  }

  const resolvedPath = path.join(
    loadWorkflowPaths().skillsRoot,
    skillName,
    'SKILL.md',
  );
  const relativePath = toDisplayPath(resolvedPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Skill 不存在：${skillName}`);
  }
  return relativePath;
};

export const validateRoutes = (config = loadRoutes()): RouteValidationResult => {
  const errors: string[] = [];
  const baseDocs = Array.isArray(config.baseDocs) ? config.baseDocs : [];
  const denied = new Set(config.denyEagerDocs || []);
  const deniedPaths = new Set<string>();
  denied.forEach((selector) => {
    try {
      deniedPaths.add(selectorFilePath(selector));
    } catch (error: unknown) {
      errors.push(`denyEagerDocs: ${errorMessage(error)}`);
    }
  });
  const riskCatalog = Array.isArray(config.riskCatalog) ? config.riskCatalog : [];
  const riskCatalogSet = new Set(riskCatalog);
  const routeEntries = Object.entries(config.routes || {});

  if (!Number.isInteger(config.version) || config.version < 1) {
    errors.push('routes.json version 必须是正整数');
  }
  const verificationContract = config.verificationContract || {};
  if (verificationContract.version !== 1) {
    errors.push('verificationContract.version 必须为 1');
  }
  const verificationContractStart = Date.parse(
    verificationContract.requiredForSpecsCreatedOnOrAfter || '',
  );
  if (Number.isNaN(verificationContractStart)) {
    errors.push(
      'verificationContract.requiredForSpecsCreatedOnOrAfter 必须是合法 date-time',
    );
  }
  if (baseDocs.length === 0) {
    errors.push('routes.json 缺少 baseDocs');
  }
  if (routeEntries.length === 0) {
    errors.push('routes.json 缺少 routes');
  }
  if (riskCatalog.length === 0) {
    errors.push('routes.json 缺少 riskCatalog');
  }
  riskCatalog.forEach((riskFlag) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(riskFlag)) {
      errors.push(`riskCatalog 包含非法风险标识：${riskFlag}`);
    }
  });
  if (riskCatalogSet.size !== riskCatalog.length) {
    errors.push('riskCatalog 包含重复风险标识');
  }

  const microChangeGate = config.microChangeGate;
  if (!microChangeGate || typeof microChangeGate !== 'object' ||
      Array.isArray(microChangeGate)) {
    errors.push('routes.json 缺少 microChangeGate');
  } else {
    const gateFields: Array<keyof RoutesConfig['microChangeGate']> = [
      'repositories',
      'minFiles',
      'maxFiles',
      'minSemanticLines',
      'maxSemanticLines',
    ];
    gateFields.forEach((field) => {
      if (!Number.isInteger(microChangeGate[field]) ||
          microChangeGate[field] < 1) {
        errors.push(`microChangeGate.${field} 必须是正整数`);
      }
    });
    if (microChangeGate.minFiles > microChangeGate.maxFiles) {
      errors.push('microChangeGate.minFiles 不能大于 maxFiles');
    }
    if (microChangeGate.minSemanticLines > microChangeGate.maxSemanticLines) {
      errors.push(
        'microChangeGate.minSemanticLines 不能大于 maxSemanticLines',
      );
    }
  }

  const knownPaths = new Set<string>();
  const registerPath = (
    relativePath: string,
    owner: string,
    { eager = false }: { eager?: boolean } = {},
  ): void => {
    try {
      readCharacterCount(relativePath);
      knownPaths.add(relativePath);
      if (eager && deniedPaths.has(selectorFilePath(relativePath))) {
        errors.push(`${owner}: 禁止把深度参考加入启动链 ${relativePath}`);
      }
    } catch (error: unknown) {
      errors.push(`${owner}: ${errorMessage(error)}`);
    }
  };

  baseDocs.forEach((relativePath) =>
    registerPath(relativePath, 'baseDocs', { eager: true }));
  (config.globalReferences || []).forEach((relativePath) =>
    registerPath(relativePath, 'globalReferences'));

  let alwaysOnChars = 0;
  try {
    alwaysOnChars = unique(baseDocs)
      .reduce((total, relativePath) => total + readCharacterCount(relativePath), 0);
  } catch {
    // Individual path errors were recorded above.
  }

  const alwaysOnLimit = config.limits?.alwaysOnMaxChars;
  if (!Number.isInteger(alwaysOnLimit) || alwaysOnLimit <= 0) {
    errors.push('limits.alwaysOnMaxChars 必须是正整数');
  } else if (alwaysOnChars > alwaysOnLimit) {
    errors.push(`始终加载文档 ${alwaysOnChars} 字符，超过预算 ${alwaysOnLimit}`);
  }

  const cardLimit = config.limits?.cardMaxChars;
  if (!Number.isInteger(cardLimit) || cardLimit <= 0) {
    errors.push('limits.cardMaxChars 必须是正整数');
  }
  const toolOutputDefaultChars = config.limits?.toolOutputDefaultChars;
  if (!Number.isInteger(toolOutputDefaultChars) || toolOutputDefaultChars <= 0) {
    errors.push('limits.toolOutputDefaultChars 必须是正整数');
  }
  const routePacketReserveChars = config.limits?.routePacketReserveChars;
  if (!Number.isInteger(routePacketReserveChars) || routePacketReserveChars <= 0) {
    errors.push('limits.routePacketReserveChars 必须是正整数');
  }
  const routeWarningRemainingRatio =
    config.limits?.routeWarningRemainingRatio;
  if (!Number.isFinite(routeWarningRemainingRatio) ||
      routeWarningRemainingRatio <= 0 ||
      routeWarningRemainingRatio >= 1) {
    errors.push('limits.routeWarningRemainingRatio 必须是 0 到 1 之间的数字');
  }

  const routeSummaries: RouteValidationResult['routeSummaries'] = [];
  routeEntries.forEach(([routeName, route]) => {
    const stages = Object.entries(route.stages || {});
    const stageNames = new Set(stages.map(([stageName]) => stageName));
    const taskFlow = route.taskFlow;
    if (!Array.isArray(route.entryModes) || route.entryModes.length === 0) {
      errors.push(`${routeName}: 缺少 entryModes`);
    }
    if (!Number.isInteger(route.budgetChars) || route.budgetChars <= 0) {
      errors.push(`${routeName}: budgetChars 必须是正整数`);
    }
    if (!Number.isInteger(route.skillReserveChars) || route.skillReserveChars < 0) {
      errors.push(`${routeName}: skillReserveChars 必须是非负整数`);
    }
    if (!Array.isArray(route.reasonCodes) || route.reasonCodes.length === 0) {
      errors.push(`${routeName}: 缺少 reasonCodes`);
    }
    if (!Array.isArray(route.disallowedRiskFlags)) {
      errors.push(`${routeName}: disallowedRiskFlags 必须是数组`);
    } else {
      route.disallowedRiskFlags.forEach((riskFlag) => {
        if (!riskCatalogSet.has(riskFlag)) {
          errors.push(`${routeName}: 未知 disallowedRiskFlag ${riskFlag}`);
        }
      });
    }
    if (typeof route.onFailure !== 'string' || !route.onFailure.trim()) {
      errors.push(`${routeName}: 缺少 onFailure`);
    }
    if (stages.length === 0) {
      errors.push(`${routeName}: 缺少 stages`);
    }
    if (route.stagePaths !== undefined) {
      const stagePaths = route.stagePaths;
      if (!stagePaths ||
          typeof stagePaths !== 'object' ||
          Array.isArray(stagePaths) ||
          Object.keys(stagePaths).length === 0) {
        errors.push(`${routeName}: stagePaths 必须是非空对象`);
      } else {
        Object.entries(stagePaths).forEach(([pathName, stagePath]) => {
          if (!Array.isArray(stagePath) || stagePath.length === 0) {
            errors.push(`${routeName}.stagePaths.${pathName}: 路径不能为空`);
            return;
          }
          stagePath.forEach((stageName) => {
            if (!stageNames.has(stageName)) {
              errors.push(
                `${routeName}.stagePaths.${pathName}: 未知 Stage ${stageName}`,
              );
            }
          });
        });
      }
    }
    if (taskFlow) {
      const taskStages = Array.isArray(taskFlow.stages) ? taskFlow.stages : [];
      const optionalStages = Array.isArray(taskFlow.optionalStages)
        ? taskFlow.optionalStages
        : [];
      const transitions = taskFlow.transitions || {};
      if (taskStages.length === 0) {
        errors.push(`${routeName}.taskFlow: stages 不能为空`);
      }
      if (new Set(taskStages).size !== taskStages.length) {
        errors.push(`${routeName}.taskFlow: stages 包含重复项`);
      }
      optionalStages.forEach((stageName) => {
        if (!taskStages.includes(stageName)) {
          errors.push(`${routeName}.taskFlow: optional stage 不存在 ${stageName}`);
        }
      });
      taskStages.forEach((stageName, index) => {
        const targets = transitions[stageName];
        if (!Array.isArray(targets) || targets.length === 0) {
          errors.push(`${routeName}.taskFlow: ${stageName} 缺少 transition`);
          return;
        }
        targets.forEach((target) => {
          if (target !== 'complete' && !taskStages.includes(target)) {
            errors.push(
              `${routeName}.taskFlow: ${stageName} 指向未知阶段 ${target}`,
            );
          }
          if (target !== 'complete' &&
              taskStages.indexOf(target) <= index) {
            errors.push(
              `${routeName}.taskFlow: ${stageName} 不能回退到 ${target}`,
            );
          }
        });
      });
      const finalStage = taskStages.at(-1);
      if (finalStage && !transitions[finalStage]?.includes('complete')) {
        errors.push(`${routeName}.taskFlow: 最终阶段必须能转换到 complete`);
      }
      taskStages.forEach((taskStage) => {
        const owners = stages
          .filter(([, stage]) => stage.taskStages?.includes(taskStage))
          .map(([stageName]) => stageName);
        if (owners.length !== 1) {
          errors.push(
            `${routeName}.taskFlow: ${taskStage} 必须映射到唯一运行阶段，实际 ${owners.length}`,
          );
        }
      });
    }
    const taskRequiredStages = route.taskRequiredStages;
    if (taskRequiredStages !== undefined) {
      if (!taskFlow) {
        errors.push(`${routeName}.taskRequiredStages 需要先定义 taskFlow`);
      } else if (!Array.isArray(taskRequiredStages)) {
        errors.push(`${routeName}.taskRequiredStages 必须是数组`);
      } else {
        if (new Set(taskRequiredStages).size !== taskRequiredStages.length) {
          errors.push(`${routeName}.taskRequiredStages 包含重复项`);
        }
        taskRequiredStages.forEach((stageName) => {
          if (!stageNames.has(stageName)) {
            errors.push(
              `${routeName}.taskRequiredStages 包含未知运行阶段 ${stageName}`,
            );
          }
        });
      }
    }

    (route.references || []).forEach((relativePath) =>
      registerPath(relativePath, `${routeName}.references`));

    stages.forEach(([stageName, stage]) => {
      const docs = Array.isArray(stage.docs) ? stage.docs : [];
      const stageReferences = Array.isArray(stage.references)
        ? stage.references
        : [];
      if (docs.length === 0) {
        errors.push(`${routeName}/${stageName}: 缺少 docs`);
      }
      if (!stage.next) {
        errors.push(`${routeName}/${stageName}: 缺少 next`);
      }
      if (taskFlow) {
        if (!Array.isArray(stage.taskStages) || stage.taskStages.length === 0) {
          errors.push(`${routeName}/${stageName}: taskFlow 路由必须登记 taskStages`);
        } else {
          if (new Set(stage.taskStages).size !== stage.taskStages.length) {
            errors.push(`${routeName}/${stageName}: taskStages 包含重复项`);
          }
          if (stage.taskStages.includes('complete') &&
              stage.taskStages.length !== 1) {
            errors.push(
              `${routeName}/${stageName}: complete 必须是唯一 taskStage`,
            );
          }
          stage.taskStages.forEach((taskStage) => {
            if (taskStage !== 'complete' &&
                !taskFlow.stages.includes(taskStage)) {
              errors.push(
                `${routeName}/${stageName}: 未知 taskStage ${taskStage}`,
              );
            }
          });
        }
      } else if (stage.taskStages !== undefined) {
        errors.push(`${routeName}/${stageName}: 无 taskFlow 时不得登记 taskStages`);
      }

      docs.forEach((relativePath) => {
        registerPath(relativePath, `${routeName}/${stageName}`, { eager: true });
        let insideCards = false;
        try {
          insideCards = isPathInside(
            selectorFilePath(relativePath),
            realpathSync(path.join(workflowRoot, 'resources', 'cards')),
          );
        } catch {
          // registerPath 已记录非法或缺失路径。
        }
        if (!insideCards) {
          errors.push(`${routeName}/${stageName}: 运行时文档必须位于 cards/：${relativePath}`);
        }
        if (Number.isInteger(cardLimit)) {
          try {
            const cardChars = readCharacterCount(relativePath);
            if (cardChars > cardLimit) {
              errors.push(
                `${relativePath}: ${cardChars} 字符，超过单卡预算 ${cardLimit}`,
              );
            }
          } catch {
            // Missing paths were recorded above.
          }
        }
      });
      stageReferences.forEach((relativePath) => {
        registerPath(relativePath, `${routeName}/${stageName}.references`);
        if (!(route.references || []).includes(relativePath)) {
          errors.push(
            `${routeName}/${stageName}: Reference 未登记到 Route ${relativePath}`,
          );
        }
      });

      try {
        const startupDocs = unique([...baseDocs, ...docs]);
        const documentChars = startupDocs
          .reduce((total, relativePath) => total + readCharacterCount(relativePath), 0);
        const optionalReferences = unique([
          ...(config.globalReferences || []),
          ...stageReferences,
        ]);
        const largestReferenceChars = optionalReferences.reduce(
          (largest, reference) => Math.max(
            largest,
            readCharacterCount(reference),
          ),
          0,
        );
        const projectedChars = documentChars +
          route.skillReserveChars +
          largestReferenceChars +
          (Number.isInteger(routePacketReserveChars) ? routePacketReserveChars : 0);
        routeSummaries.push({
          budgetChars: route.budgetChars,
          projectedChars,
          route: routeName,
          stage: stageName,
        });
        if (projectedChars > route.budgetChars) {
          errors.push(
            `${routeName}/${stageName}: 预计 ${projectedChars} 字符，超过预算 ${route.budgetChars}`,
          );
        }
        optionalReferences.forEach((reference) => {
          const withReferenceChars = documentChars +
            readCharacterCount(reference) +
            (Number.isInteger(routePacketReserveChars)
              ? routePacketReserveChars
              : 0);
          if (withReferenceChars > route.budgetChars) {
            errors.push(
              `${routeName}/${stageName}: Reference ${reference} 预计 ` +
              `${withReferenceChars} 字符，超过预算 ${route.budgetChars}`,
            );
          }
        });
      } catch {
        // Missing paths were recorded above.
      }
    });
  });

  return {
    alwaysOnChars,
    alwaysOnLimit,
    errors,
    knownPaths: [...knownPaths],
    routeSummaries,
  };
};

export const buildRoutePacket = ({
  classification = null,
  entry,
  microBrief = null,
  microGuard = null,
  microRepository = null,
  parentRunId = '',
  references = [],
  riskFlags = [],
  route: routeName,
  runId = '',
  skills = [],
  stage: stageName,
  taskId = '',
}: BuildRoutePacketOptions): RoutePacket => {
  const config = loadRoutes();
  const profile = loadActiveProfile();
  const validation = validateRoutes(config);
  if (validation.errors.length > 0) {
    throw new Error(`路由配置未通过校验：${validation.errors[0]}`);
  }

  const route = config.routes[routeName];
  if (!route) {
    throw new Error(`未知 Route：${routeName}`);
  }
  const stage = route.stages?.[stageName];
  if (!stage) {
    throw new Error(`Route ${routeName} 不包含 Stage ${stageName}`);
  }
  if (!route.entryModes.includes(entry)) {
    throw new Error(
      `Route ${routeName} 不接受 Entry ${entry}，允许值：${route.entryModes.join(', ')}`,
    );
  }

  if (!Array.isArray(riskFlags)) {
    throw new Error('riskFlags 必须是数组');
  }
  if (!Array.isArray(skills)) {
    throw new Error('skills 必须是数组');
  }
  if (!Array.isArray(references)) {
    throw new Error('references 必须是数组');
  }
  if (taskId && !TASK_ID_PATTERN.test(taskId)) {
    throw new Error('Task ID 只能包含小写字母、数字和连字符');
  }
  if (parentRunId && !RUN_ID_PATTERN.test(parentRunId)) {
    throw new Error('Parent Run ID 不符合格式');
  }
  if (classification) {
    if (classification.route !== routeName) {
      throw new Error(
        `结构化事实判定 Route 为 ${classification.route}，不能生成 ${routeName}`,
      );
    }
    if (classification.entry !== entry) {
      throw new Error(
        `结构化事实 Entry 为 ${classification.entry}，不能生成 Entry ${entry}`,
      );
    }
    if (routeName === 'micro-change') {
      if (!classification.changeType) {
        throw new Error('Micro Change 分类缺少 changeType');
      }
      const stagePath = route.stagePaths?.[classification.changeType] || [];
      if (!stagePath.includes(stageName)) {
        throw new Error(
          `Micro Change ${classification.changeType} 分类不能进入 Stage ${stageName}`,
        );
      }
    }
  } else if (routeName === 'micro-change') {
    throw new Error(
      'Micro Change 必须通过结构化事实分类；在 workflow:route 中提供 --intent 和全部 Gate 事实',
    );
  }

  const selectedRiskFlags = unique([
    ...(classification?.riskFlags || []),
    ...riskFlags,
  ]);
  const unknownRiskFlags = selectedRiskFlags
    .filter((riskFlag) => !config.riskCatalog.includes(riskFlag));
  if (unknownRiskFlags.length > 0) {
    throw new Error(`未知 Risk Flag：${unknownRiskFlags.join(', ')}`);
  }
  const blockedRiskFlags = selectedRiskFlags
    .filter((riskFlag) => route.disallowedRiskFlags.includes(riskFlag));
  if (blockedRiskFlags.length > 0) {
    throw new Error(
      `Route ${routeName} 禁止风险标识 ${blockedRiskFlags.join(', ')}；${route.onFailure}`,
    );
  }

  const allowedReferences = unique([
    ...(config.globalReferences || []),
    ...(stage.references || []),
  ]);
  const referenceDocs = unique(references);
  const disallowedReferences = referenceDocs
    .filter((relativePath) => !allowedReferences.includes(relativePath));
  if (disallowedReferences.length > 0) {
    throw new Error(
      `Route ${routeName}/${stageName} 不允许 Reference：` +
      disallowedReferences.join(', '),
    );
  }
  referenceDocs.forEach(readCharacterCount);
  const instructionDocs = unique([
    ...config.baseDocs,
    ...stage.docs,
    ...referenceDocs,
  ]);
  const skillDocs = unique(skills).map(resolveSkill);
  const materializeDocs = unique([
    ...stage.docs,
    ...skillDocs,
    ...referenceDocs,
  ]);
  const documentChars = instructionDocs
    .reduce((total, relativePath) => total + readCharacterCount(relativePath), 0);
  const skillChars = skillDocs
    .reduce((total, relativePath) => total + readCharacterCount(relativePath), 0);
  const materializeContentChars = materializeDocs
    .reduce((total, relativePath) => total + readCharacterCount(relativePath), 0);
  const loadedChars = documentChars + skillChars;
  const configuredPacketReserveChars = config.limits.routePacketReserveChars;
  const usedChars = loadedChars + configuredPacketReserveChars;

  if (usedChars > route.budgetChars) {
    throw new Error(
      `Route Packet ${usedChars} 字符，超过 ${route.budgetChars} 字符预算；` +
      '请减少 Skill、拆分阶段或升级为按需 Reference',
    );
  }

  const packet: RoutePacketBase = {
    budgetChars: route.budgetChars,
    changeType: classification?.changeType ?? null,
    decision: {
      classified: Boolean(classification),
      confidence: classification ? 1 : null,
      confidenceBasis: classification
        ? 'structured-facts'
        : 'manual-route-selection',
      onFailure: route.onFailure,
      reasonCodes: classification?.reasonCodes ?? route.reasonCodes,
      riskFlags: selectedRiskFlags,
    },
    entry,
    instructionDocs,
    loadedChars,
    materializeContentChars,
    materializeDocs,
    microBrief,
    microGuard,
    microRepository,
    next: stage.next,
    optionalReferences: allowedReferences
      .filter((relativePath) => !referenceDocs.includes(relativePath)),
    packetReserveChars: configuredPacketReserveChars,
    parentRunId: parentRunId || 'none',
    profile: describeProfileBinding(profile, entry),
    routesVersion: config.version,
    route: routeName,
    runId: runId || 'none',
    referenceDocs,
    skillDocs,
    stage: stageName,
    taskId: taskId || 'none',
    toolOutputDefaultChars: config.limits.toolOutputDefaultChars,
    usedChars,
  };
  let packetChars = Array.from(`${formatRoutePacket(packet)}\n`).length;
  // Reserve and used counts are part of the formatted metadata, so converge them together.
  for (
    let pass = 0;
    packetChars > packet.packetReserveChars && pass < MAX_PACKET_RESERVE_PASSES;
    pass += 1
  ) {
    packet.packetReserveChars = packetChars;
    packet.usedChars = loadedChars + packet.packetReserveChars;
    if (packet.usedChars > route.budgetChars) {
      throw new Error(
        `Route Packet ${packet.usedChars} 字符，超过 ${route.budgetChars} 字符预算；` +
        '请减少 Skill、Reference 或拆分阶段',
      );
    }
    packetChars = Array.from(`${formatRoutePacket(packet)}\n`).length;
  }
  if (packetChars > packet.packetReserveChars) {
    throw new Error('Route Packet 元数据预留计算未在限定次数内收敛');
  }

  return {
    ...packet,
    packetChars,
  };
};

export const formatRoutePacket = (packet: RoutePacketBase): string => [
  'Route Packet',
  `- Route: ${packet.route}`,
  `- Stage: ${packet.stage}`,
  `- Entry: ${packet.entry}`,
  `- Profile: ${packet.profile.id} | Source: ${packet.profile.sourceProvider} | ` +
    `Review: ${packet.profile.reviewSkill}`,
  `- Run: ${packet.runId}`,
  packet.parentRunId !== 'none' ? `- Parent Run: ${packet.parentRunId}` : '',
  `- Task: ${packet.taskId}`,
  `- Context Budget (reserved): ${packet.usedChars}/${packet.budgetChars} chars`,
  `- Loaded Content: ${packet.loadedChars} chars`,
  `- Route Packet Reserve: ${packet.packetReserveChars} chars`,
  `- Tool Output Default Cap: ${packet.toolOutputDefaultChars} chars`,
  `- Decision Reasons: ${packet.decision.reasonCodes.join(', ')}`,
  `- Decision Confidence: ${packet.decision.confidence ?? 'not-scored'} ` +
    `(${packet.decision.confidenceBasis})`,
  packet.changeType ? `- Change Type: ${packet.changeType}` : '',
  packet.microRepository
    ? `- Target Repository: ${packet.microRepository.repository} ` +
      `(${packet.microGuard
        ? 'source-bound'
        : packet.microBrief ? 'brief-aligned' : 'location-hint'})`
    : '',
  packet.microGuard
    ? `- Micro Guard: passed (${packet.microGuard.repositoryCount} repo, ` +
      `${packet.microGuard.fileCount} files, ${packet.microGuard.semanticLines} lines, ` +
      `patch ${packet.microGuard.patchHash}, source ${packet.microGuard.sourceHash})`
    : '',
  packet.microBrief
    ? `- Micro Brief: passed (G${packet.microBrief.goalCount}, ` +
      `AC${packet.microBrief.acceptanceCount}, OOS${packet.microBrief.outOfScopeCount}, ` +
      `C${packet.microBrief.changeCount}, VT${packet.microBrief.verificationCount}, ` +
      `plan ${packet.microBrief.planHash})`
    : '',
  `- Risk Flags: ${
    packet.decision.riskFlags.length > 0 ? packet.decision.riskFlags.join(', ') : 'none'
  }`,
  `- On Failure: ${packet.decision.onFailure}`,
  `- Instruction Docs: ${packet.instructionDocs.join(', ')}`,
  `- Skill Docs: ${packet.skillDocs.length > 0 ? packet.skillDocs.join(', ') : 'none'}`,
  `- Reference Docs: ${
    packet.referenceDocs.length > 0 ? packet.referenceDocs.join(', ') : 'none'
  }`,
  `- Runtime Context Delta: ${packet.materializeContentChars} chars from ` +
    `${packet.materializeDocs.join(', ')}`,
  `- Optional References (not loaded): ${
    packet.optionalReferences.length > 0
      ? packet.optionalReferences.join(', ')
      : 'none'
  }`,
  `- Next: ${packet.next}`,
  '- Rule: only Instruction Docs, Skill Docs and task evidence are loaded; ' +
    'switch route before reading other workflow docs.',
].filter(Boolean).join('\n');

export const materializeRoutePacket = (
  packet: RoutePacket,
  format: 'json' | 'text' = 'text',
): MaterializationResult => {
  if (!['text', 'json'].includes(format)) {
    throw new Error('materialize format 只支持 text 或 json');
  }

  const requestedContext = packet.materializeDocs.map((relativePath) => ({
    content: readWorkspaceText(relativePath),
    path: relativePath,
  }));
  // Base Docs already exist in the agent context. Keep materialized metadata compact so
  // the fixed tool-output budget is spent on instructions that are new for this stage.
  const compactPacket = () => [
    `Runtime Context: ${packet.route}/${packet.stage} | Entry: ${packet.entry} | ` +
      `Run: ${packet.runId}`,
    `Profile: ${packet.profile.id} | Source: ${packet.profile.sourceProvider} | ` +
      `Review: ${packet.profile.reviewSkill}`,
    `Budget: ${packet.usedChars}/${packet.budgetChars} chars | Next: ${packet.next}`,
  ];
  const renderOutput = (
    materializedContext: MaterializedDocument[],
    omittedMaterializeDocs: string[],
  ): string => {
    const materializedDocs = materializedContext.map(({ path: relativePath }) =>
      relativePath);
    const materializationComplete = omittedMaterializeDocs.length === 0;
    return format === 'json'
      ? JSON.stringify({
        ...packet,
        materializationComplete,
        materializedContext,
        materializedDocs,
        omittedMaterializeDocs,
      }, null, 2)
      : [
        ...compactPacket(),
        '# Emitted Runtime Context',
        '以下内容只输出到终端，不写入任务目录；Base Docs 已在启动上下文中，' +
          '本段按阶段卡、Skill、Reference 的优先级合并完整文档。',
        `- Materialization: ${materializationComplete ? 'complete' : 'partial'} ` +
          `(${materializedDocs.length}/${packet.materializeDocs.length} docs)`,
        ...(omittedMaterializeDocs.length > 0
          ? [`- Remaining Context Docs: ${omittedMaterializeDocs.join(', ')}`]
          : []),
        ...materializedContext.map(({ content, path: relativePath }) =>
          [
            '',
            `--- BEGIN ${relativePath} ---`,
            content.trimEnd(),
            `--- END ${relativePath} ---`,
          ].join('\n')),
      ].join('\n');
  };
  const fullOutput = renderOutput(requestedContext, []);
  const fullOutputChars = Array.from(`${fullOutput}\n`).length;
  if (fullOutputChars <= packet.toolOutputDefaultChars) {
    return {
      complete: true,
      materializedDocs: packet.materializeDocs,
      omittedDocs: [],
      output: fullOutput,
      outputChars: fullOutputChars,
      requestedOutputChars: fullOutputChars,
    };
  }

  let materializedContext: MaterializedDocument[] = [];
  for (let index = 0; index < requestedContext.length; index += 1) {
    const candidateContext = requestedContext.slice(0, index + 1);
    const candidateOutput = renderOutput(
      candidateContext,
      packet.materializeDocs.slice(index + 1),
    );
    const candidateChars = Array.from(`${candidateOutput}\n`).length;
    if (candidateChars > packet.toolOutputDefaultChars) {
      break;
    }
    materializedContext = candidateContext;
  }

  if (materializedContext.length === 0) {
    throw new Error(
      `Materialized Packet 为 ${fullOutputChars} 字符，超过工具输出上限 ` +
      `${packet.toolOutputDefaultChars}；首份阶段文档也无法完整输出；` +
      '请使用普通 Route Packet 按白名单读取',
    );
  }

  const omittedDocs = packet.materializeDocs.slice(materializedContext.length);
  const output = renderOutput(materializedContext, omittedDocs);
  const outputChars = Array.from(`${output}\n`).length;
  return {
    complete: false,
    materializedDocs: materializedContext.map(({ path: relativePath }) => relativePath),
    omittedDocs,
    output,
    outputChars,
    requestedOutputChars: fullOutputChars,
  };
};

export const displayRoutesPath = () => toDisplayPath(routesPath);
