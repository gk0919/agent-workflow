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

/** 确保 Route 使用的每个持久化任务阶段都已被 Active Profile 接受。 */
export const validateProfileTaskStages = (
  profile: WorkflowProfile,
  routes: RoutesConfig,
): string[] => {
  const knownStages = new Set(profile.taskModel.knownStages);
  return Object.entries(routes.routes).flatMap(([routeName, route]) =>
    (route.taskFlow?.stages ?? [])
      .filter((stageName) => !knownStages.has(stageName))
      .map((stageName) =>
        `${routeName}.taskFlow 使用 Profile 未登记阶段：${stageName}`));
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
