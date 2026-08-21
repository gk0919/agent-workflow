export type {
  RemotePluginDescriptor,
  RemotePluginProtocol,
} from '../contracts/transport.js';

import type { PluginJsonObject } from '../contracts/json.js';

/** Minimal MCP capability declaration kept independent from a concrete MCP SDK. */
export interface McpCapabilityBinding {
  readonly name: string;
  readonly options?: Readonly<PluginJsonObject>;
  readonly serverId: string;
  readonly type: 'prompt' | 'resource' | 'tool';
}

export interface McpPluginConnection {
  close(): Promise<void>;
  invoke(
    binding: McpCapabilityBinding,
    input: PluginJsonObject,
  ): Promise<PluginJsonObject>;
}
