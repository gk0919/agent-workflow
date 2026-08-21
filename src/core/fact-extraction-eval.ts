import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  classifyRouteFacts,
  normalizeRouteFacts,
} from './classify-route.js';
import { loadRoutes } from './context-budget.js';
import { casesPath, materializeRouteCase } from './route-eval.js';
import type { RouteEvalSuite } from './route-eval.js';
import type { RouteFacts, RoutesConfig } from '../types/contracts.js';
import { errorMessage } from '../types/guards.js';
const MAX_PREDICTIONS_BYTES = 1024 * 1024;

export interface FactPrediction {
  facts: Partial<RouteFacts>;
  id: string;
  promptHash: string;
}

export interface FactPredictionSet {
  cases: FactPrediction[];
  version: number;
}

const hashPrompt = (prompt: string): string => createHash('sha256')
  .update(prompt, 'utf8')
  .digest('hex');

const loadSuite = (): RouteEvalSuite =>
  JSON.parse(readFileSync(casesPath, 'utf8')) as RouteEvalSuite;

const readPredictionsFromStdin = (): FactPredictionSet => {
  const content = readFileSync(0);
  if (content.length > MAX_PREDICTIONS_BYTES) {
    throw new Error(`预测集超过 ${MAX_PREDICTIONS_BYTES} 字节上限`);
  }
  const text = content.toString('utf8');
  if (text.includes('\uFFFD')) {
    throw new Error('预测集必须是有效 UTF-8 JSON');
  }
  return JSON.parse(text) as FactPredictionSet;
};

export const buildFactExtractionChallenge = (suite: RouteEvalSuite = loadSuite()) => {
  assert.ok(Array.isArray(suite.cases), '路由用例 cases 必须是数组');
  const ids = new Set<string>();
  return {
    version: suite.version,
    cases: suite.cases.map(({ id, prompt }) => {
      assert.ok(!ids.has(id), `重复文本评测 ID：${id}`);
      assert.ok(prompt?.trim(), `${id}: 缺少自然语言 prompt`);
      ids.add(id);
      return {
        id,
        prompt,
        promptHash: hashPrompt(prompt),
      };
    }),
  };
};

export const evaluateFactExtractions = (
  predictions: FactPredictionSet,
  suite: RouteEvalSuite = loadSuite(),
  config: RoutesConfig = loadRoutes(),
) => {
  assert.equal(predictions.version, suite.version, '预测集版本不匹配');
  assert.ok(Array.isArray(predictions.cases), '预测集 cases 必须是数组');
  const predictionById = new Map<string, FactPrediction>();
  predictions.cases.forEach((prediction) => {
    assert.ok(!predictionById.has(prediction.id), `重复预测 ID：${prediction.id}`);
    predictionById.set(prediction.id, prediction);
  });

  suite.cases.map(materializeRouteCase).forEach((testCase) => {
    const prediction = predictionById.get(testCase.id);
    assert.ok(prediction, `${testCase.id}: 缺少文本事实提取结果`);
    assert.equal(
      prediction.promptHash,
      hashPrompt(testCase.prompt),
      `${testCase.id}: promptHash 不匹配`,
    );
    assert.deepEqual(
      normalizeRouteFacts(prediction.facts),
      normalizeRouteFacts(testCase.facts),
      `${testCase.id}: 提取 facts 与金标准不一致`,
    );
    if (testCase.expected.error) {
      assert.throws(
        () => classifyRouteFacts(prediction.facts, config),
        new RegExp(testCase.expected.error),
        `${testCase.id}: expected error`,
      );
      return;
    }
    const decision = classifyRouteFacts(prediction.facts, config);
    assert.equal(decision.route, testCase.expected.route, `${testCase.id}: route`);
    assert.equal(decision.stage, testCase.expected.stage, `${testCase.id}: stage`);
  });

  assert.equal(
    predictionById.size,
    suite.cases.length,
    '预测集包含未知或多余用例',
  );
  return {
    caseCount: suite.cases.length,
  };
};

export const main = (args: string[] = process.argv.slice(2)): number => {
  try {
    if (args.length === 1 && args[0] === '--emit') {
      process.stdout.write(
        `${JSON.stringify(buildFactExtractionChallenge(), null, 2)}\n`,
      );
      return 0;
    }
    if (args.length === 1 && args[0] === '--check-suite') {
      const challenge = buildFactExtractionChallenge();
      process.stdout.write(
        `文本事实提取 Eval 语料检查通过：${challenge.cases.length} 个 prompt。\n`,
      );
      return 0;
    }
    if (args.length === 1 && args[0] === '--predictions-stdin') {
      const predictions = readPredictionsFromStdin();
      const result = evaluateFactExtractions(predictions);
      process.stdout.write(
        `文本事实提取 Eval 通过：${result.caseCount} 个自然语言用例。\n`,
      );
      return 0;
    }
    throw new Error(
      'Usage: agent-workflow routes:prompt-eval ' +
      '<--check-suite|--emit|--predictions-stdin>',
    );
  } catch (error: unknown) {
    process.stderr.write(`文本事实提取 Eval 失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
