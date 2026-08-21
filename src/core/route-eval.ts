import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadActiveProfile,
  resolveWorkflowLocator,
} from '../config/workflow-config.js';
import { classifyRouteFacts } from './classify-route.js';
import { loadRoutes } from './context-budget.js';
import type { RouteFacts } from '../types/contracts.js';
import { errorMessage } from '../types/guards.js';

export interface RouteEvalCase {
  expected: {
    blocker?: string;
    changeType?: string;
    error?: string;
    microChangeEligible?: boolean;
    route?: string;
    stage?: string;
  };
  facts: Partial<RouteFacts>;
  id: string;
  prompt: string;
  risk?: string;
}

export interface RouteEvalSuite {
  cases: RouteEvalCase[];
  version: number;
}

const activeProfile = loadActiveProfile();
export const casesPath = resolveWorkflowLocator(
  activeProfile.evals.routeCases,
  'evals.routeCases',
);

const baseMicroChangeFacts = {
  acceptanceClear: true,
  changeType: activeProfile.taskModel.changeTypes[0] ?? '',
  entry: activeProfile.taskModel.changeEntryModes[0] ?? '',
  files: 1,
  goalClear: true,
  hasValidationPath: true,
  intent: 'change',
  repositories: 1,
  semanticLines: 2,
  uniqueLocation: true,
};

export const materializeRouteCase = (testCase: RouteEvalCase): RouteEvalCase => testCase.risk
  ? {
    ...testCase,
    expected: {
      blocker: `risk:${testCase.risk}`,
      route: 'standard-change',
      stage: 'capture',
    },
    facts: {
      ...baseMicroChangeFacts,
      riskFlags: [testCase.risk],
    },
  }
  : testCase;

export const main = (): number => {
  try {
    const config = loadRoutes();
    const suite = JSON.parse(readFileSync(casesPath, 'utf8')) as RouteEvalSuite;
    assert.equal(suite.version, 1);
    assert.ok(Array.isArray(suite.cases));
    assert.ok(suite.cases.length >= 30, '路由 Eval 至少需要 30 个用例');

    const ids = new Set<string>();
    const routeCounts = new Map<string, number>();
    const coveredRisks = new Set<string>();
    suite.cases.map(materializeRouteCase).forEach((testCase) => {
      assert.match(testCase.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(!ids.has(testCase.id), `重复用例 ID：${testCase.id}`);
      ids.add(testCase.id);
      assert.ok(testCase.prompt?.trim(), `${testCase.id}: 缺少 prompt`);
      if (testCase.risk) {
        coveredRisks.add(testCase.risk);
      }

      if (testCase.expected.error) {
        assert.throws(
          () => classifyRouteFacts(testCase.facts, config, activeProfile),
          new RegExp(testCase.expected.error),
          `${testCase.id}: expected error`,
        );
        return;
      }

      const decision = classifyRouteFacts(testCase.facts, config, activeProfile);
      assert.equal(decision.route, testCase.expected.route, `${testCase.id}: route`);
      assert.equal(decision.stage, testCase.expected.stage, `${testCase.id}: stage`);
      if (typeof testCase.expected.microChangeEligible === 'boolean') {
        assert.equal(
          decision.microChangeEligible,
          testCase.expected.microChangeEligible,
          `${testCase.id}: microChangeEligible`,
        );
      }
      if (testCase.expected.changeType) {
        assert.equal(
          decision.changeType,
          testCase.expected.changeType,
          `${testCase.id}: changeType`,
        );
      }
      if (testCase.expected.blocker) {
        assert.ok(
          decision.blockers.includes(testCase.expected.blocker),
          `${testCase.id}: 缺少 blocker ${testCase.expected.blocker}`,
        );
      }
      routeCounts.set(decision.route, (routeCounts.get(decision.route) || 0) + 1);
    });

    ['micro-change', 'standard-change', 'analysis', 'review-only']
      .forEach((route) =>
        assert.ok(routeCounts.has(route), `Eval 缺少 ${route} 用例`));
    config.riskCatalog.forEach((riskFlag) =>
      assert.ok(coveredRisks.has(riskFlag), `Eval 缺少风险用例 ${riskFlag}`));
    process.stdout.write(
      `结构化事实路由 Eval 通过：${suite.cases.length} 个用例，` +
      `${routeCounts.get('micro-change')} 个 Micro Change 正例，` +
      `${routeCounts.get('standard-change')} 个升级反例。\n`,
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`结构化事实路由 Eval 失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
