import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  activeProfilePathFor,
  describeProfileBinding,
  loadActiveProfile,
  loadWorkflowConfig,
  loadWorkflowPaths,
  workflowConfigPath,
} from '../config/workflow-config.js';
import { workspaceRoot } from '../config/workspace-paths.js';
import type { RoutesConfig, WorkflowProfile } from '../types/contracts.js';
import { errorMessage } from '../types/guards.js';
import { loadRoutes } from './context-budget.js';

const displayPath = (filePath: string): string =>
  path.relative(workspaceRoot, filePath).split(path.sep).join('/');

/** 确保 Active Profile 的任务词汇、入口绑定和 Route 契约彼此闭合。 */
export const validateProfileTaskStages = (
  profile: WorkflowProfile,
  routes: RoutesConfig,
): string[] => {
  const errors: string[] = [];
  const knownStages = new Set(profile.taskModel.knownStages);
  errors.push(...Object.entries(routes.routes).flatMap(([routeName, route]) =>
    (route.taskFlow?.stages ?? [])
      .filter((stageName) => !knownStages.has(stageName))
      .map((stageName) =>
        `${routeName}.taskFlow 使用 Profile 未登记阶段：${stageName}`)));

  const providers = new Set(Object.keys(profile.sourceProviders));
  const requiredProviderEntries = new Set([
    ...profile.taskModel.artifactEntryModes,
    ...profile.taskModel.changeEntryModes,
    profile.taskModel.providerEntryMode,
  ].filter((entry) => !['none', 'not-applicable'].includes(entry)));
  requiredProviderEntries.forEach((entry) => {
    if (!providers.has(entry)) {
      errors.push(`Profile 入口缺少 sourceProviders 绑定：${entry}`);
    }
  });

  Object.entries(profile.taskModel.intentRoutes).forEach(([intent, target]) => {
    if (!target) {
      return;
    }
    const [routeName, stageName] = target;
    const route = routes.routes[routeName];
    if (!route) {
      errors.push(`intentRoutes.${intent} 指向未知 Route：${routeName}`);
    } else if (!route.stages[stageName]) {
      errors.push(`intentRoutes.${intent} 指向未知 Stage：${routeName}/${stageName}`);
    }
  });

  Object.entries(profile.taskModel.expectedIntentEntries).forEach(([intent, entries]) => {
    const target = profile.taskModel.intentRoutes[intent];
    if (target === undefined) {
      errors.push(`expectedIntentEntries.${intent} 缺少 intentRoutes 声明`);
      return;
    }
    if (!target) {
      errors.push(`expectedIntentEntries.${intent} 不能绑定 change intent`);
      return;
    }
    const route = routes.routes[target[0]];
    if (!route) {
      return;
    }
    entries.forEach((entry) => {
      if (!route.entryModes.includes(entry)) {
        errors.push(
          `expectedIntentEntries.${intent} 的入口 ${entry} 未被 Route ${target[0]} 接受`,
        );
      }
    });
  });

  const microRoute = routes.routes['micro-change'];
  Object.entries(profile.taskModel.microStages).forEach(([changeType, stageName]) => {
    if (!microRoute?.stages[stageName]) {
      errors.push(`microStages.${changeType} 指向未知 Stage：micro-change/${stageName}`);
    }
    if (!microRoute?.stagePaths?.[changeType]?.includes(stageName)) {
      errors.push(`microStages.${changeType} 未绑定 micro-change.stagePaths.${changeType}`);
    }
  });
  return errors;
};

/** 生成精简报告，不暴露 Profile 内容或仓库数据。 */
export const buildProfileReport = () => {
  const config = loadWorkflowConfig();
  const profile = loadActiveProfile(config);
  const stageErrors = validateProfileTaskStages(profile, loadRoutes());
  if (stageErrors.length > 0) {
    throw new Error(stageErrors.join('；'));
  }
  const paths = loadWorkflowPaths(config);
  return {
    bindings: Object.fromEntries(
      Object.keys(profile.sourceProviders).map((entry) => [
        entry,
        describeProfileBinding(profile, entry),
      ])),
    config: displayPath(workflowConfigPath),
    profile: profile.id,
    profilePath: activeProfilePathFor(config),
    paths: Object.fromEntries(
      Object.entries(paths).map(([key, filePath]) => [key, displayPath(filePath)]),
    ),
    schemaVersion: config.schemaVersion,
  };
};

/** 校验并报告 Active Profile，供 CLI 和质量门禁使用。 */
export const main = (args: string[] = process.argv.slice(2)): number => {
  const unknownArgs = args.filter((argument) => !['--check', '--json'].includes(argument));
  if (unknownArgs.length > 0) {
    process.stderr.write(`未知参数：${unknownArgs.join(', ')}\n`);
    return 1;
  }
  try {
    const report = buildProfileReport();
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Workflow Profile 检查通过：${report.profile} ` +
        `(${report.profilePath})；配置 ${report.config}。\n`,
      );
    }
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`Workflow Profile 检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
