import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadRoutes,
} from './context-budget.js';
import { workflowRoot } from '../config/workspace-paths.js';
import type { RoutesConfig } from '../types/contracts.js';
import { errorMessage } from '../types/guards.js';

const readmePath = path.join(workflowRoot, 'README.md');
const startMarker = '<!-- ai-workflow:routes:start -->';
const endMarker = '<!-- ai-workflow:routes:end -->';

export const renderRoutesTable = (config: RoutesConfig = loadRoutes()): string => [
  startMarker,
  '| Route | Entry | Runtime Stages |',
  '|---|---|---|',
  ...Object.entries(config.routes).map(([routeName, route]) => {
    const entries = route.entryModes.map((entry) => `\`${entry}\``).join(', ');
    const renderPath = (stagePath: string[]): string => stagePath
      .map((stage: string) => `\`${stage}\``)
      .join(' → ');
    const stages = route.stagePaths
      ? Object.entries(route.stagePaths)
        .map(([pathName, stagePath]) =>
          `\`${pathName}\`: ${renderPath(stagePath)}`)
        .join('<br>')
      : renderPath(Object.keys(route.stages));
    return `| \`${routeName}\` | ${entries} | ${stages} |`;
  }),
  endMarker,
].join('\n');

const replaceManagedBlock = (content: string, block: string): string => {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error('README 缺少合法的运行路由表标记');
  }
  const duplicateStart = content.indexOf(startMarker, startIndex + startMarker.length);
  const duplicateEnd = content.indexOf(endMarker, endIndex + endMarker.length);
  if (duplicateStart >= 0 || duplicateEnd >= 0) {
    throw new Error('README 包含重复的运行路由表标记');
  }
  return [
    content.slice(0, startIndex),
    block,
    content.slice(endIndex + endMarker.length),
  ].join('');
};

export const checkRoutesDocumentation = () => {
  const content = readFileSync(readmePath, 'utf8');
  const expected = replaceManagedBlock(content, renderRoutesTable());
  return {
    content,
    expected,
    matches: content === expected,
  };
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  try {
    const mode = args[0] ?? '--check';
    if (!['--check', '--write'].includes(mode) || args.length > 1) {
      throw new Error('Usage: agent-workflow routes:docs [--check|--write]');
    }
    const result = checkRoutesDocumentation();
    if (mode === '--write') {
      if (!result.matches) {
        writeFileSync(readmePath, result.expected, 'utf8');
      }
      process.stdout.write(
        result.matches ? '运行路由表无需更新。\n' : '运行路由表已更新。\n',
      );
      return 0;
    }
    if (!result.matches) {
      process.stderr.write(
        '运行路由表与 routes.json 不一致；运行 npm run workflow:routes:docs -- --write。\n',
      );
      return 1;
    }
    process.stdout.write('运行路由表与 routes.json 一致。\n');
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`运行路由表检查失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
