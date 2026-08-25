import process from 'node:process';
import {
  AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION,
  type AgentExecutorProcessRequest,
  type AgentExecutorProcessResponse,
} from '../../../src/contracts/executor-transport.js';
import {
  AGENT_EXECUTOR_API_VERSION,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentExecutorCapabilities,
} from '../../../src/contracts/execution.js';
import type { PluginJsonValue } from '../../../src/contracts/json.js';

const capabilities: AgentExecutorCapabilities = {
  apiVersion: AGENT_EXECUTOR_API_VERSION,
  capabilities: ['structured-output'],
  features: {
    cancellation: true,
    modelRouting: false,
    persistentResume: false,
    structuredOutput: true,
    toolAllowlist: true,
    usageReporting: true,
    workspaceIsolation: false,
  },
  maxConcurrency: 1,
};

const outputFor = (request: AgentExecutionRequest): PluginJsonValue => {
  if (request.nodeId === 'source') {
    return { items: [{ key: 'alpha' }, { key: 'beta' }] };
  }
  if (request.nodeId === 'inspect-items' && request.lane) {
    return { accepted: true, key: request.lane.index === 0 ? 'alpha' : 'beta' };
  }
  if (request.nodeId === 'verify') {
    return process.argv.includes('--invalid-output')
      ? { count: 'two', valid: true }
      : { count: 2, valid: true };
  }
  return null;
};

const execute = (request: AgentExecutionRequest): AgentExecutionResult => ({
  apiVersion: AGENT_EXECUTOR_API_VERSION,
  artifacts: [],
  attempt: request.attempt,
  executor: {
    id: process.argv.includes('--wrong-executor-id')
      ? 'process/unexpected'
      : 'process/conformance',
  },
  findings: [],
  ...(request.lane ? { laneId: request.lane.id } : {}),
  nodeId: request.nodeId,
  output: outputFor(request),
  retryable: false,
  runId: request.runId,
  status: 'succeeded',
  usage: {
    durationMs: 1,
    inputTokens: 2,
    outputTokens: 3,
    toolCalls: 0,
  },
});

const readInput = async (): Promise<string> => {
  let content = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    content += chunk;
  }
  return content;
};

const main = async (): Promise<void> => {
  const raw = await readInput();
  if (process.argv.includes('--invalid-json')) {
    process.stdout.write('{invalid');
    return;
  }
  const envelope = JSON.parse(raw) as AgentExecutorProcessRequest;
  const result = envelope.action === 'describe'
    ? capabilities
    : execute(envelope.request);
  const response: AgentExecutorProcessResponse = {
    ok: true,
    protocolVersion: AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION,
    requestId: process.argv.includes('--wrong-request-id')
      ? 'wrong-request-id'
      : envelope.requestId,
    result,
  };
  process.stdout.write(JSON.stringify(response));
};

void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
