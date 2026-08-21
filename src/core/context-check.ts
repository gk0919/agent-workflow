import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  displayRoutesPath,
  loadRoutes,
  validateRoutes,
} from './context-budget.js';
import { errorMessage } from '../types/guards.js';

export const main = (): number => {
  let config;
  let validation;
  try {
    config = loadRoutes();
    validation = validateRoutes(config);
  } catch (error: unknown) {
    process.stderr.write(`上下文预算检查失败：${errorMessage(error)}\n`);
    return 1;
  }

  validation.errors.forEach((message) =>
    process.stderr.write(`ERROR: ${message}\n`));
  if (validation.errors.length > 0) {
    process.stderr.write(
      `上下文预算检查失败：${validation.errors.length} 个错误。\n`,
    );
    return 1;
  }

  const largestRoute = validation.routeSummaries
    .slice()
    .sort((left, right) => right.projectedChars - left.projectedChars)[0];
  if (!largestRoute) {
    process.stderr.write('上下文预算检查失败：没有可用 Route。\n');
    return 1;
  }
  const warningRatio = config.limits.routeWarningRemainingRatio;
  const lowMarginRoutes = validation.routeSummaries
    .filter(({ budgetChars, projectedChars }) =>
      (budgetChars - projectedChars) / budgetChars < warningRatio)
    .sort((left, right) =>
      (left.budgetChars - left.projectedChars) -
      (right.budgetChars - right.projectedChars));
  if (lowMarginRoutes.length > 0) {
    process.stderr.write(
      `WARN: ${lowMarginRoutes.length} 个 Route 的预算余量低于 ` +
      `${Math.round(warningRatio * 100)}%：` +
      `${lowMarginRoutes.slice(0, 5)
        .map(({ budgetChars, projectedChars, route, stage }) =>
          `${route}/${stage} ${projectedChars}/${budgetChars}`)
        .join(', ')}。\n`,
    );
  }
  process.stdout.write(
    `上下文预算检查通过：always-on ${validation.alwaysOnChars}/` +
    `${validation.alwaysOnLimit} chars；最大 Route ` +
    `${largestRoute.route}/${largestRoute.stage} ` +
    `${largestRoute.projectedChars}/${largestRoute.budgetChars} chars；` +
    `配置 ${displayRoutesPath()}。\n`,
  );
  return 0;
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
