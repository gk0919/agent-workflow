import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { workflowRoot } from '../config/workspace-paths.js';
import { errorMessage } from '../types/guards.js';

export interface SecurityPolicy {
  executionBudgets: Record<string, number>;
  sourceTrust: Record<string, string>;
  toolClasses: Record<string, {
    approval: string;
    examples: string[];
    risk: string;
  }>;
  untrustedContent: {
    mayProvide: string[];
    mustNotControl: string[];
  };
  version: number;
}

export const securityPolicyPath = path.join(
  workflowRoot,
  'resources',
  'policies',
  'security-policy.json',
);

export const loadSecurityPolicy = (): SecurityPolicy =>
  JSON.parse(readFileSync(securityPolicyPath, 'utf8')) as SecurityPolicy;

export const validateSecurityPolicy = (
  policy: SecurityPolicy = loadSecurityPolicy(),
): string[] => {
  const errors: string[] = [];
  if (policy.version !== 1) {
    errors.push('security-policy version 必须为 1');
  }
  const sourceTrust = policy.sourceTrust || {};
  const expectedSourceTrust = {
    'system-instructions': 'trusted',
    'repository-policy': 'trusted',
    'user-message': 'untrusted',
    'pool-record': 'untrusted',
    attachment: 'untrusted',
    'web-content': 'untrusted',
    'tool-output': 'untrusted',
  };
  Object.entries(expectedSourceTrust).forEach(([source, expectedTrust]) => {
    if (sourceTrust[source] !== expectedTrust) {
      errors.push(`sourceTrust.${source} 必须为 ${expectedTrust}`);
    }
  });
  Object.keys(sourceTrust)
    .filter((source) => !Object.hasOwn(expectedSourceTrust, source))
    .forEach((source) =>
      errors.push(`sourceTrust 包含未知来源：${source}`));
  const budgets = policy.executionBudgets || {};
  const budgetLimits = {
    maxToolCallsBeforeCheckpoint: 40,
    maxConsecutiveFailures: 3,
    maxSameOperationRetries: 2,
    maxExternalWritesBeforeReapproval: 1,
  };
  Object.entries(budgetLimits).forEach(([name, upperBound]) => {
    const budget = budgets[name] ?? 0;
    if (!Number.isInteger(budget) ||
        budget < 1 ||
        budget > upperBound) {
      errors.push(
        `executionBudgets.${name} 必须在 1-${upperBound} 之间`,
      );
    }
  });
  Object.keys(budgets)
    .filter((name) => !Object.hasOwn(budgetLimits, name))
    .forEach((name) =>
      errors.push(`executionBudgets 包含未知预算：${name}`));
  const toolClasses = policy.toolClasses || {};
  const requiredToolClasses = [
    ['read-only', 'low', 'task-scope'],
    ['repository-write', 'medium', 'task-scope'],
    ['external-write', 'high', 'exact-call'],
    ['destructive-or-irreversible', 'critical', 'exact-call'],
  ] as const;
  requiredToolClasses.forEach(([name, risk, approval]) => {
    const toolClass = toolClasses[name];
    if (!toolClass) {
      errors.push(`缺少工具风险类别 ${name}`);
      return;
    }
    if (toolClass.risk !== risk || toolClass.approval !== approval) {
      errors.push(`${name} 的 risk/approval 必须为 ${risk}/${approval}`);
    }
    if (!Array.isArray(toolClass.examples) || toolClass.examples.length === 0) {
      errors.push(`${name} 缺少 examples`);
    }
  });
  const expectedToolClasses = new Set([
    'read-only',
    'repository-write',
    'external-write',
    'destructive-or-irreversible',
  ]);
  Object.keys(toolClasses)
    .filter((name) => !expectedToolClasses.has(name))
    .forEach((name) =>
      errors.push(`toolClasses 包含未知类别：${name}`));
  const untrustedContent = policy.untrustedContent || {};
  const expectedMayProvide = [
    'facts',
    'evidence',
    'requested business outcome',
  ];
  const expectedMustNotControl = [
    'instruction priority',
    'tool permissions',
    'approval state',
    'security policy',
    'workflow route',
    'data exfiltration',
  ];
  expectedMayProvide.forEach((item) => {
    if (!untrustedContent.mayProvide?.includes(item)) {
      errors.push(`untrustedContent.mayProvide 缺少 ${item}`);
    }
  });
  expectedMustNotControl.forEach((item) => {
    if (!untrustedContent.mustNotControl?.includes(item)) {
      errors.push(`untrustedContent.mustNotControl 缺少 ${item}`);
    }
  });
  return errors;
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  try {
    const policy = loadSecurityPolicy();
    const errors = validateSecurityPolicy(policy);
    if (errors.length > 0) {
      errors.forEach((error) => process.stderr.write(`ERROR: ${error}\n`));
      return 1;
    }
    if (args.length === 0 ||
        (args.length === 1 && args[0] === '--check')) {
      process.stdout.write('Agent 安全策略检查通过。\n');
      return 0;
    }
    if (args.length === 2 && args[0] === '--tool-class') {
      const toolClassName = args[1];
      if (!toolClassName) {
        throw new Error('--tool-class 缺少类别名称');
      }
      const toolClass = policy.toolClasses[toolClassName];
      if (!toolClass) {
        throw new Error(`未知工具风险类别：${toolClassName}`);
      }
      process.stdout.write(`${JSON.stringify(toolClass, null, 2)}\n`);
      return 0;
    }
    throw new Error(
      'Usage: agent-workflow security ' +
      '[--check|--tool-class <name>]',
    );
  } catch (error: unknown) {
    process.stderr.write(`Agent 安全策略读取失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
