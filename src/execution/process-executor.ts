import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION,
  type AgentExecutorProcessRequest,
  type AgentExecutorProcessResponse,
} from '../contracts/executor-transport.js';
import type {
  AgentCancellationRequest,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutorCapabilities,
  AgentExecutorService,
} from '../contracts/execution.js';
import {
  hashPortableJson,
  serializeCanonicalJson,
} from '../core/execution-plan.js';

const DEFAULT_DESCRIBE_TIMEOUT_MS = 5000;
const MAX_PROTOCOL_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const EXECUTE_TRANSPORT_GRACE_MS = 2000;

export interface ProcessAgentExecutorOptions {
  readonly arguments?: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly describeTimeoutMs?: number;
  readonly id: string;
  readonly maxResponseBytes?: number;
  readonly maxStderrBytes?: number;
}

const nonEmpty = (value: string, label: string): string => {
  if (value.trim() === '' || value.includes('\u0000')) {
    throw new Error(`${label} 不能为空且不能包含 NUL`);
  }
  return value;
};

const positiveInteger = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} 必须为正整数`);
  }
  return resolved;
};

const recordValue = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Process Executor 响应必须是 JSON object');
  }
  return value as Record<string, unknown>;
};

const executionKey = (request: {
  readonly attempt: number;
  readonly laneId?: string;
  readonly nodeId: string;
  readonly runId: string;
}): string => [request.runId, request.nodeId, request.laneId, request.attempt]
  .filter((part) => part !== undefined)
  .join(':');

/**
 * Executes one JSON request in a fresh, shell-free child process. The command is
 * explicit host configuration; Workflow Definitions can never select it.
 */
export class ProcessAgentExecutor implements AgentExecutorService {
  readonly id: string;
  readonly #arguments: readonly string[];
  readonly #command: string;
  readonly #cwd: string | undefined;
  readonly #describeTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxStderrBytes: number;
  readonly #active = new Map<string, ChildProcessWithoutNullStreams>();
  #describeSequence = 0;

  constructor(options: ProcessAgentExecutorOptions) {
    this.id = nonEmpty(options.id, 'Process Executor id');
    this.#command = nonEmpty(options.command, 'Process Executor command');
    this.#arguments = (options.arguments ?? []).map((argument) =>
      nonEmpty(argument, 'Process Executor argument'));
    this.#cwd = options.cwd === undefined
      ? undefined
      : nonEmpty(options.cwd, 'Process Executor cwd');
    this.#describeTimeoutMs = positiveInteger(
      options.describeTimeoutMs,
      DEFAULT_DESCRIBE_TIMEOUT_MS,
      'describeTimeoutMs',
    );
    this.#maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    );
    this.#maxStderrBytes = positiveInteger(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      'maxStderrBytes',
    );
  }

  async cancel(request: AgentCancellationRequest): Promise<void> {
    this.#active.get(executionKey({
      attempt: request.attempt,
      ...(request.laneId ? { laneId: request.laneId } : {}),
      nodeId: request.nodeId,
      runId: request.runId,
    }))?.kill();
  }

  async describe(): Promise<AgentExecutorCapabilities> {
    this.#describeSequence += 1;
    const envelope: AgentExecutorProcessRequest = {
      action: 'describe',
      protocolVersion: AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION,
      requestId: `describe:${this.#describeSequence}`,
    };
    return await this.#exchange(envelope, this.#describeTimeoutMs) as AgentExecutorCapabilities;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const envelope: AgentExecutorProcessRequest = {
      action: 'execute',
      protocolVersion: AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION,
      request: structuredClone(request),
      requestId: request.idempotencyKey,
    };
    const key = executionKey({
      attempt: request.attempt,
      ...(request.lane ? { laneId: request.lane.id } : {}),
      nodeId: request.nodeId,
      runId: request.runId,
    });
    const result = await this.#exchange(
      envelope,
      request.limits.maxDurationMs + EXECUTE_TRANSPORT_GRACE_MS,
      key,
    );
    const resultRecord = recordValue(result);
    const executor = recordValue(resultRecord.executor);
    if (executor.id !== this.id) {
      throw new Error('Process Executor Result 的 executor.id 与配置不匹配');
    }
    return result as AgentExecutionResult;
  }

  async #exchange(
    envelope: AgentExecutorProcessRequest,
    timeoutMs: number,
    activeKey?: string,
  ): Promise<unknown> {
    hashPortableJson(envelope, MAX_PROTOCOL_REQUEST_BYTES);
    return await new Promise<unknown>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.#command, [...this.#arguments], {
          ...(this.#cwd ? { cwd: this.#cwd } : {}),
          env: process.env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error: unknown) {
        reject(error);
        return;
      }

      if (activeKey) {
        this.#active.set(activeKey, child);
      }
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        if (activeKey && this.#active.get(activeKey) === child) {
          this.#active.delete(activeKey);
        }
      };
      const fail = (error: Error, kill = false): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (kill) {
          child.kill();
        }
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error(`Process Executor 响应超时：${timeoutMs}ms`), true);
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > this.#maxResponseBytes) {
          fail(new Error('Process Executor stdout 超过上限'), true);
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > this.#maxStderrBytes) {
          fail(new Error('Process Executor stderr 超过上限'), true);
          return;
        }
      });
      child.once('error', (error) => fail(error));
      child.stdin.once('error', (error) => fail(error));
      child.once('close', (code, signal) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          fail(new Error(
            `Process Executor 退出异常：code=${code ?? 'none'}, signal=${signal ?? 'none'}` +
            (stderrBytes > 0 ? `，stderrBytes=${stderrBytes}` : ''),
          ));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown;
          hashPortableJson(parsed, this.#maxResponseBytes);
        } catch {
          fail(new Error('Process Executor 响应不是有效 JSON'));
          return;
        }
        try {
          const response = recordValue(parsed) as unknown as AgentExecutorProcessResponse;
          if (
            response.protocolVersion !== AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION ||
            response.requestId !== envelope.requestId ||
            typeof response.ok !== 'boolean'
          ) {
            throw new Error('Process Executor 响应身份或协议版本不匹配');
          }
          if (!response.ok) {
            if (
              typeof response.error?.code !== 'string' ||
              typeof response.error?.message !== 'string'
            ) {
              throw new Error('Process Executor error 响应无效');
            }
            throw new Error(
              `Process Executor 拒绝请求：${response.error.code}: ${response.error.message}`,
            );
          }
          if (response.result === undefined) {
            throw new Error('Process Executor success 响应缺少 result');
          }
          settled = true;
          cleanup();
          resolve(response.result);
        } catch (error: unknown) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stdin.end(`${serializeCanonicalJson(envelope)}\n`);
    });
  }
}
