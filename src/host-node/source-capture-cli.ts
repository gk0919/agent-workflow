import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { SourceProviderService } from '../contracts/capabilities.js';
import { loadWorkflowConfig } from '../config/workflow-config.js';
import { workspaceRoot } from '../config/workspace-paths.js';
import { sourceProviderService } from '../plugin-sdk/index.js';
import { errorMessage } from '../types/guards.js';
import { createNodePluginHost } from './index.js';

interface SourceCaptureOptions {
  entry: string;
  format: 'json' | 'pretty';
  providerId: string;
  reference: string;
}

const usage = [
  'Usage:',
  '  agent-workflow source:capture --entry <entry> --reference <id> [options]',
  '',
  'Options:',
  '  --provider <id>    Select one provider when multiple are active.',
  '  --format <format>  json or pretty (default: pretty).',
].join('\n');

const argumentValue = (args: readonly string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && (!value || value.startsWith('--'))) {
    throw new Error(`${name} 缺少参数值`);
  }
  return value ?? '';
};

export const readSourceCaptureArguments = (args: readonly string[]): SourceCaptureOptions => {
  const knownArguments = new Set([
    '--entry',
    '--format',
    '--provider',
    '--reference',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument || !knownArguments.has(argument)) {
      throw new Error(`未知参数：${argument ?? ''}`);
    }
    index += 1;
  }
  const entry = argumentValue(args, '--entry').trim();
  const reference = argumentValue(args, '--reference').trim();
  const formatValue = argumentValue(args, '--format') || 'pretty';
  if (!entry || !reference) {
    throw new Error('必须提供 --entry 和 --reference');
  }
  if (formatValue !== 'json' && formatValue !== 'pretty') {
    throw new Error('--format 只支持 json 或 pretty');
  }
  return {
    entry,
    format: formatValue,
    providerId: argumentValue(args, '--provider').trim(),
    reference,
  };
};

export const selectSourceProvider = (
  providers: readonly SourceProviderService[],
  providerId: string,
): SourceProviderService => {
  if (providerId) {
    const provider = providers.find(({ id }) => id === providerId);
    if (!provider) {
      throw new Error(`找不到 source-provider：${providerId}`);
    }
    return provider;
  }
  if (providers.length === 0) {
    throw new Error('没有已激活的 source-provider 插件');
  }
  if (providers.length > 1) {
    throw new Error(
      `存在多个 source-provider，请使用 --provider 指定：` +
      providers.map(({ id }) => id).join(', '),
    );
  }
  return providers[0] as SourceProviderService;
};

/** Activates configured plugins and captures one source through the public service contract. */
export const main = async (args: string[] = process.argv.slice(2)): Promise<number> => {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }

  let failure: unknown;
  let host: Awaited<ReturnType<typeof createNodePluginHost>> | undefined;
  try {
    const options = readSourceCaptureArguments(args);
    host = await createNodePluginHost(loadWorkflowConfig(), { workspaceRoot });
    await host.start();
    const provider = selectSourceProvider(
      host.getServices(sourceProviderService),
      options.providerId,
    );
    const result = await provider.capture({
      entry: options.entry,
      reference: options.reference,
    });
    process.stdout.write(
      `${JSON.stringify(result, null, options.format === 'pretty' ? 2 : 0)}\n`,
    );
  } catch (error: unknown) {
    failure = error;
  } finally {
    if (host?.state === 'running') {
      try {
        await host.stop();
      } catch (error: unknown) {
        failure = failure
          ? new AggregateError([failure, error], 'Source capture 与插件清理均失败')
          : error;
      }
    }
  }
  if (failure) {
    process.stderr.write(`Source capture 失败：${errorMessage(failure)}\n${usage}\n`);
    return 1;
  }
  return 0;
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
