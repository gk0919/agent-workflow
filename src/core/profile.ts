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
import { errorMessage } from '../types/guards.js';

const displayPath = (filePath: string): string =>
  path.relative(workspaceRoot, filePath).split(path.sep).join('/');

/** Builds a compact report without exposing Profile contents or repository data. */
export const buildProfileReport = () => {
  const config = loadWorkflowConfig();
  const profile = loadActiveProfile(config);
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

/** Validates and reports the Active Profile for CLI and quality-gate use. */
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
