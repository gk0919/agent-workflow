import process from 'node:process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadWorkflowConfig } from '../config/workflow-config.js';
import { workspaceRoot } from '../config/workspace-paths.js';
import { errorMessage } from '../types/guards.js';
import { createNodePluginHost } from './index.js';

/** Loads, activates and reverses every configured plugin as a lifecycle contract check. */
export const main = async (args: string[] = process.argv.slice(2)): Promise<number> => {
  const unknownArguments = args.filter((argument) => argument !== '--json');
  if (unknownArguments.length > 0) {
    process.stderr.write(`未知参数：${unknownArguments.join(', ')}\n`);
    return 1;
  }
  try {
    const host = await createNodePluginHost(loadWorkflowConfig(), { workspaceRoot });
    await host.start();
    const status = host.status();
    await host.stop();
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ plugins: status }, null, 2)}\n`);
    } else {
      process.stdout.write(`插件检查通过：已验证 ${status.length} 个插件的完整生命周期。\n`);
    }
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`插件检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
