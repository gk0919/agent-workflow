import type { PluginJsonValue } from './json.js';
import type { PluginManifest } from './plugin.js';

export const PLUGIN_RPC_PROTOCOL_VERSION = 1 as const;
export const PLUGIN_RPC_METHODS = [
  'plugin.activate',
  'plugin.deactivate',
  'plugin.describe',
  'service.invoke',
] as const;

export type PluginRpcMethod = typeof PLUGIN_RPC_METHODS[number];

export interface PluginRpcRequest {
  readonly id: string;
  readonly jsonrpc: '2.0';
  readonly method: PluginRpcMethod;
  readonly params?: PluginJsonValue;
  readonly protocolVersion: typeof PLUGIN_RPC_PROTOCOL_VERSION;
}

export interface PluginRpcError {
  readonly code: number;
  readonly data?: PluginJsonValue;
  readonly message: string;
}

export interface PluginRpcResponse {
  readonly error?: PluginRpcError;
  readonly id: string;
  readonly jsonrpc: '2.0';
  readonly protocolVersion: typeof PLUGIN_RPC_PROTOCOL_VERSION;
  readonly result?: PluginJsonValue;
}

/** Transport implemented by isolated Python, Rust, C# or Node plugin processes. */
export interface PluginRpcTransport {
  close(): Promise<void>;
  request(request: PluginRpcRequest): Promise<PluginRpcResponse>;
}

export interface ProcessPluginDescriptor {
  readonly arguments?: readonly string[];
  readonly command: string;
  readonly manifest: PluginManifest;
}

export type RemotePluginProtocol = 'grpc' | 'http' | 'mcp';

export interface RemotePluginDescriptor {
  readonly endpoint: string;
  readonly manifest: PluginManifest;
  readonly protocol: RemotePluginProtocol;
}
