import {
  AGENT_EXECUTOR_API_VERSION,
  type AgentCancellationRequest,
  type AgentExecutionError,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentExecutionStatus,
  type AgentExecutionUsage,
  type AgentExecutorCapabilities,
  type AgentExecutorService,
} from '../contracts/execution.js';
import type { PluginJsonValue } from '../contracts/json.js';
import type { ValidationFinding } from '../contracts/capabilities.js';

export interface NativeAgentHostResult {
  readonly artifacts?: readonly string[];
  readonly error?: AgentExecutionError;
  readonly findings?: readonly ValidationFinding[];
  readonly model?: string;
  readonly output?: PluginJsonValue;
  readonly retryable?: boolean;
  readonly status: AgentExecutionStatus;
  readonly usage?: Partial<AgentExecutionUsage>;
}

/** Minimal host-native surface; scheduling, retry and persistence stay in the kernel. */
export interface NativeAgentHost {
  readonly id: string;
  cancel?(request: AgentCancellationRequest): Promise<void>;
  getCapabilities(): Promise<AgentExecutorCapabilities>;
  invoke(request: AgentExecutionRequest): Promise<NativeAgentHostResult>;
}

/** Adapts an in-process host SDK without leaking provider-specific types into Core. */
export class NativeHostAgentExecutor implements AgentExecutorService {
  readonly id: string;
  readonly #host: NativeAgentHost;

  constructor(host: NativeAgentHost) {
    if (host.id.trim() === '') {
      throw new Error('Native Agent Host id 不能为空');
    }
    this.#host = host;
    this.id = host.id;
  }

  async cancel(request: AgentCancellationRequest): Promise<void> {
    await this.#host.cancel?.(structuredClone(request));
  }

  async describe(): Promise<AgentExecutorCapabilities> {
    return structuredClone(await this.#host.getCapabilities());
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const result = await this.#host.invoke(structuredClone(request));
    return {
      apiVersion: AGENT_EXECUTOR_API_VERSION,
      artifacts: [...(result.artifacts ?? [])],
      attempt: request.attempt,
      executor: {
        id: this.id,
        ...(result.model ? { model: result.model } : {}),
      },
      findings: structuredClone(result.findings ?? []),
      ...(request.lane ? { laneId: request.lane.id } : {}),
      nodeId: request.nodeId,
      retryable: result.retryable ?? false,
      runId: request.runId,
      status: result.status,
      usage: {
        durationMs: result.usage?.durationMs ?? 0,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        toolCalls: result.usage?.toolCalls ?? null,
      },
      ...(result.error ? { error: structuredClone(result.error) } : {}),
      ...(result.output !== undefined ? { output: structuredClone(result.output) } : {}),
    };
  }
}
