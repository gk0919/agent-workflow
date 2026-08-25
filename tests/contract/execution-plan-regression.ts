import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { WorkflowDefinition, WorkflowNode } from '../../src/contracts/execution.js';
import {
  compileStaticExecutionPlan,
  validateExecutionEvent,
  validateWorkflowDefinition,
} from '../../src/core/execution-plan.js';
import { workflowRoot, workspaceRoot } from '../../src/config/workspace-paths.js';
import { errorMessage } from '../../src/types/guards.js';

const SAMPLE_PATH = path.join(
  workflowRoot,
  'resources',
  'examples',
  'workflow-definition.sample.json',
);
const CLI_PATH = path.join(workflowRoot, 'dist', 'bin', 'agent-workflow.js');

const sample = JSON.parse(readFileSync(SAMPLE_PATH, 'utf8')) as WorkflowDefinition;

const withGraph = (
  nodes: readonly WorkflowNode[],
  resultNode: string,
  limits: Partial<WorkflowDefinition['limits']> = {},
): WorkflowDefinition => ({
  id: 'regression-workflow',
  limits: {
    maxAgents: 10,
    maxAttemptsPerNode: 2,
    maxConcurrency: 4,
    maxDurationMs: 60000,
    maxExternalWrites: 0,
    maxIterations: 1,
    ...limits,
  },
  nodes,
  resultNode,
  schemaVersion: 1,
});

const agent = (
  id: string,
  dependsOn: readonly string[] = [],
  additions: Partial<Extract<WorkflowNode, { type: 'agent' }>> = {},
): Extract<WorkflowNode, { type: 'agent' }> => ({
  dependsOn,
  id,
  prompt: `Run ${id}`,
  type: 'agent',
  ...additions,
});

const hasFinding = (value: unknown, pattern: RegExp): void => {
  const findings = validateWorkflowDefinition(value);
  assert.ok(
    findings.some((finding) => pattern.test(finding)),
    `未找到预期错误 ${pattern}；实际为：${findings.join(' | ')}`,
  );
};

const runCli = (args: string[]) => spawnSync(process.execPath, [CLI_PATH, ...args], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  env: process.env,
  windowsHide: true,
});

export const main = (): number => {
  try {
    assert.deepEqual(validateWorkflowDefinition(sample), []);
    const plan = compileStaticExecutionPlan(sample);
    assert.deepEqual(plan.layers, [
      ['discover'],
      ['correctness-review', 'security-review'],
      ['review-result'],
    ]);
    assert.equal(plan.nodes.at(-1)?.id, 'review-result');
    assert.match(plan.workflowHash, /^[a-f0-9]{64}$/);

    const reordered = {
      resultNode: sample.resultNode,
      nodes: sample.nodes,
      limits: sample.limits,
      id: sample.id,
      schemaVersion: sample.schemaVersion,
      ...(sample.description ? { description: sample.description } : {}),
      ...(sample.inputSchema !== undefined ? { inputSchema: sample.inputSchema } : {}),
    };
    const reorderedPlan = compileStaticExecutionPlan(reordered);
    assert.equal(reorderedPlan.workflowHash, plan.workflowHash);
    assert.equal(JSON.stringify(reorderedPlan), JSON.stringify(plan));

    hasFinding({ ...sample, unexpected: true }, /unexpected|additional properties/);
    hasFinding(withGraph([agent('same'), agent('same')], 'same'), /节点标识重复/);
    hasFinding(withGraph([agent('only', ['missing'])], 'only'), /依赖不存在/);
    hasFinding(withGraph([agent('self', ['self'])], 'self'), /不能依赖自身/);
    hasFinding(
      withGraph([agent('first', ['second']), agent('second', ['first'])], 'second'),
      /包含环/,
    );
    hasFinding(withGraph([agent('unused'), agent('result')], 'result'), /不会贡献/);
    hasFinding(
      withGraph([agent('first'), agent('second', ['first'])], 'first'),
      /结果节点必须是终端节点/,
    );
    hasFinding(
      withGraph([agent('only')], 'only', { maxAgents: 1, maxConcurrency: 2 }),
      /不得超过 maxAgents/,
    );
    hasFinding(
      withGraph(
        [
          agent('first'),
          agent('second'),
          { dependsOn: ['first', 'second'], id: 'result', type: 'join' },
        ],
        'result',
        { maxAgents: 1, maxConcurrency: 1 },
      ),
      /Agent 节点超过上限/,
    );
    hasFinding(
      withGraph([
        agent('only', [], {
          preferredCapabilities: ['review'],
          requiredCapabilities: ['review'],
        }),
      ], 'only'),
      /requiredCapabilities 与 preferredCapabilities 重复/,
    );
    hasFinding(
      withGraph([agent('only', [], { outputSchema: { $ref: 'https://example.invalid/schema' } })], 'only'),
      /只允许本地片段 \$ref/,
    );
    hasFinding(
      withGraph([agent('only', [], { outputSchema: { type: 'unknown-json-type' } })], 'only'),
      /JSON Schema 无效/,
    );
    const cyclicValue: { self?: unknown } = {};
    cyclicValue.self = cyclicValue;
    hasFinding(cyclicValue, /循环对象引用/);
    hasFinding(new Proxy({}, {
      getPrototypeOf() {
        throw new Error('untrusted proxy');
      },
    }), /无法安全读取/);

    const sharedSchema = { type: 'string' };
    assert.deepEqual(validateWorkflowDefinition({
      ...sample,
      inputSchema: {
        allOf: [sharedSchema, sharedSchema],
      },
    }), []);

    const validEvent = {
      attempt: 1,
      eventId: 'event-0123456789abcdef',
      nodeId: 'discover',
      payload: {},
      runId: 'run-0123456789abcdef',
      schemaVersion: 1,
      sequence: 2,
      timestamp: '2026-08-25T00:00:00.000Z',
      type: 'node.started',
      workflowHash: plan.workflowHash,
      workflowId: sample.id,
    };
    assert.deepEqual(validateExecutionEvent(validEvent), []);
    const { attempt: _attempt, ...eventWithoutAttempt } = validEvent;
    assert.ok(validateExecutionEvent(eventWithoutAttempt).some((finding) => /attempt/.test(finding)));
    assert.ok(validateExecutionEvent({
      ...validEvent,
      type: 'run.started',
    }).length > 0);
    assert.ok(validateExecutionEvent({
      ...validEvent,
      payload: { createdAt: new Date() },
    }).some((finding) => /普通对象/.test(finding)));

    const cli = runCli([
      'execution:plan',
      '--file',
      'resources/examples/workflow-definition.sample.json',
      '--format',
      'json',
    ]);
    assert.equal(cli.status, 0, cli.stderr);
    const cliPlan = JSON.parse(cli.stdout) as { layers: string[][]; workflowHash: string };
    assert.deepEqual(cliPlan.layers, plan.layers);
    assert.equal(cliPlan.workflowHash, plan.workflowHash);

    const unsafePath = runCli(['execution:plan', '--file', SAMPLE_PATH]);
    assert.equal(unsafePath.status, 1);
    assert.match(unsafePath.stderr, /工作区相对路径/);

    process.stdout.write(
      '执行内核 Phase 0 回归通过：结构/语义校验、确定性 DAG 计划、事件契约与公开 CLI 均稳定。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`执行内核 Phase 0 回归失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
