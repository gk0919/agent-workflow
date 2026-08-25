import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutorCapabilities,
} from './execution.js';

export const AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION = 1 as const;
export const AGENT_EXECUTOR_PROCESS_ACTIONS = ['describe', 'execute'] as const;

export type AgentExecutorProcessAction =
  typeof AGENT_EXECUTOR_PROCESS_ACTIONS[number];

interface AgentExecutorProcessRequestBase {
  readonly protocolVersion: typeof AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION;
  readonly requestId: string;
}

export interface AgentExecutorProcessDescribeRequest
  extends AgentExecutorProcessRequestBase {
  readonly action: 'describe';
}

export interface AgentExecutorProcessExecuteRequest
  extends AgentExecutorProcessRequestBase {
  readonly action: 'execute';
  readonly request: AgentExecutionRequest;
}

export type AgentExecutorProcessRequest =
  | AgentExecutorProcessDescribeRequest
  | AgentExecutorProcessExecuteRequest;

export interface AgentExecutorProcessError {
  readonly code: string;
  readonly message: string;
}

export interface AgentExecutorProcessSuccessResponse {
  readonly ok: true;
  readonly protocolVersion: typeof AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly result: AgentExecutionResult | AgentExecutorCapabilities;
}

export interface AgentExecutorProcessFailureResponse {
  readonly error: AgentExecutorProcessError;
  readonly ok: false;
  readonly protocolVersion: typeof AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION;
  readonly requestId: string;
}

export type AgentExecutorProcessResponse =
  | AgentExecutorProcessFailureResponse
  | AgentExecutorProcessSuccessResponse;
