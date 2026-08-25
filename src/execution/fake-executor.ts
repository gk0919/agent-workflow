import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ajv2020, ErrorObject } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import {
  AGENT_EXECUTOR_API_VERSION,
  type AgentCancellationRequest,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentExecutorCapabilities,
  type AgentExecutorService,
  type FakeExecutorFixture,
} from '../contracts/execution.js';
import { hashPortableJson } from '../core/execution-plan.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDirectory, '..', '..', '..');
const require = createRequire(import.meta.url);
const Ajv2020Constructor = (require('ajv/dist/2020.js') as {
  default: typeof Ajv2020;
}).default;
const addFormats = (require('ajv-formats') as { default: FormatsPlugin }).default;

const ajv = new Ajv2020Constructor({
  addUsedSchema: false,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
addFormats(ajv);
const fixtureSchema = JSON.parse(readFileSync(path.join(
  packageRoot,
  'resources',
  'schemas',
  'fake-executor-fixture.schema.json',
), 'utf8')) as Record<string, unknown>;
const fixtureValidator = ajv.compile<FakeExecutorFixture>(fixtureSchema);

const stableError = (error: ErrorObject): string => {
  const location = error.instancePath || '$';
  const detail = error.keyword === 'required' && typeof error.params.missingProperty === 'string'
    ? `缺少 ${error.params.missingProperty}`
    : error.keyword === 'additionalProperties' &&
      typeof error.params.additionalProperty === 'string'
      ? `不允许 ${error.params.additionalProperty}`
      : `未通过 ${error.keyword} 校验`;
  return `${location}: ${detail}`;
};

export const validateFakeExecutorFixture = (value: unknown): string[] => {
  try {
    hashPortableJson(value, 256 * 1024);
  } catch {
    return ['$: Fixture 必须是 256 KiB 以内的可移植 JSON'];
  }
  if (!fixtureValidator(value)) {
    return [...new Set((fixtureValidator.errors ?? []).map(stableError))].sort();
  }
  const duplicateNodeIds = value.nodes
    .map(({ nodeId }) => nodeId)
    .filter((nodeId, index, all) => all.indexOf(nodeId) !== index);
  return [...new Set(duplicateNodeIds)]
    .sort()
    .map((nodeId) => `$.nodes: nodeId 不能重复：${nodeId}`);
};

/** Deterministic executor used by conformance tests and the Phase 1 CLI. */
export class FakeAgentExecutor implements AgentExecutorService {
  readonly id: string;
  readonly #fixture: FakeExecutorFixture;
  readonly #requests: AgentExecutionRequest[] = [];
  readonly #cancellations: AgentCancellationRequest[] = [];

  constructor(value: unknown) {
    const findings = validateFakeExecutorFixture(value);
    if (findings.length > 0) {
      throw new Error(`Fake Executor Fixture 无效：\n- ${findings.join('\n- ')}`);
    }
    this.#fixture = structuredClone(value) as FakeExecutorFixture;
    this.id = this.#fixture.executorId;
  }

  get cancellations(): readonly AgentCancellationRequest[] {
    return this.#cancellations.map((request) => structuredClone(request));
  }

  get requests(): readonly AgentExecutionRequest[] {
    return this.#requests.map((request) => structuredClone(request));
  }

  async cancel(request: AgentCancellationRequest): Promise<void> {
    this.#cancellations.push(structuredClone(request));
  }

  async describe(): Promise<AgentExecutorCapabilities> {
    return structuredClone(this.#fixture.capabilities);
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.#requests.push(structuredClone(request));
    const nodeFixture = this.#fixture.nodes.find(({ nodeId }) => nodeId === request.nodeId);
    const attemptFixture = nodeFixture?.attempts[request.attempt - 1];
    if (!attemptFixture) {
      return {
        apiVersion: AGENT_EXECUTOR_API_VERSION,
        artifacts: [],
        attempt: request.attempt,
        error: {
          code: 'executor-unavailable',
          message: `Fixture 未声明 ${request.nodeId} 的第 ${request.attempt} 次结果`,
        },
        executor: { id: this.id },
        findings: [],
        nodeId: request.nodeId,
        retryable: false,
        runId: request.runId,
        status: 'failed',
        usage: {
          durationMs: 0,
          inputTokens: null,
          outputTokens: null,
          toolCalls: null,
        },
      };
    }

    const model = request.model?.required ?? request.model?.preferred;
    return {
      apiVersion: AGENT_EXECUTOR_API_VERSION,
      artifacts: [...(attemptFixture.artifacts ?? [])],
      attempt: request.attempt,
      executor: {
        id: this.id,
        ...(model ? { model } : {}),
      },
      findings: structuredClone(attemptFixture.findings ?? []),
      nodeId: request.nodeId,
      retryable: attemptFixture.retryable ?? false,
      runId: request.runId,
      status: attemptFixture.status,
      usage: {
        durationMs: attemptFixture.usage?.durationMs ?? 0,
        inputTokens: attemptFixture.usage?.inputTokens ?? null,
        outputTokens: attemptFixture.usage?.outputTokens ?? null,
        toolCalls: attemptFixture.usage?.toolCalls ?? null,
      },
      ...(attemptFixture.error ? { error: structuredClone(attemptFixture.error) } : {}),
      ...(attemptFixture.output !== undefined
        ? { output: structuredClone(attemptFixture.output) }
        : {}),
    };
  }
}
