export {
  PLUGIN_RPC_METHODS,
  PLUGIN_RPC_PROTOCOL_VERSION,
} from '../contracts/transport.js';
export type {
  PluginRpcError,
  PluginRpcMethod,
  PluginRpcRequest,
  PluginRpcResponse,
  PluginRpcTransport,
  ProcessPluginDescriptor,
} from '../contracts/transport.js';

import {
  PLUGIN_RPC_METHODS,
  PLUGIN_RPC_PROTOCOL_VERSION,
} from '../contracts/transport.js';
import type {
  PluginRpcMethod,
  PluginRpcRequest,
  PluginRpcResponse,
} from '../contracts/transport.js';
import type { PluginJsonValue } from '../contracts/json.js';

/** Creates the versioned envelope used by isolated process plugins. */
export const createPluginRpcRequest = (
  id: string,
  method: PluginRpcMethod,
  params?: PluginJsonValue,
): PluginRpcRequest => {
  if (!id || !method) {
    throw new Error('进程插件请求 id 和 method 不能为空');
  }
  if (!PLUGIN_RPC_METHODS.includes(method)) {
    throw new Error(`未知进程插件方法：${method}`);
  }
  return {
    id,
    jsonrpc: '2.0',
    method,
    ...(params === undefined ? {} : { params }),
    protocolVersion: PLUGIN_RPC_PROTOCOL_VERSION,
  };
};

/** Guards response correlation and protocol negotiation at the process boundary. */
export function assertPluginRpcResponse(
  response: unknown,
  request: PluginRpcRequest,
): asserts response is PluginRpcResponse {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('进程插件响应必须是对象');
  }
  const candidate = response as Record<string, unknown>;
  if (candidate.jsonrpc !== '2.0') {
    throw new Error(`进程插件响应不是 JSON-RPC 2.0：${String(candidate.jsonrpc)}`);
  }
  if (candidate.protocolVersion !== PLUGIN_RPC_PROTOCOL_VERSION) {
    throw new Error(`进程插件协议版本不兼容：${String(candidate.protocolVersion)}`);
  }
  if (candidate.id !== request.id) {
    throw new Error(`进程插件响应 id 不匹配：${String(candidate.id)}`);
  }
  const hasError = Object.hasOwn(candidate, 'error');
  const hasResult = Object.hasOwn(candidate, 'result');
  if (hasError === hasResult) {
    throw new Error('进程插件响应必须且只能包含 result 或 error');
  }
  if (hasError) {
    const error = candidate.error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
      throw new Error('进程插件 error 必须是对象');
    }
    const errorRecord = error as Record<string, unknown>;
    if (!Number.isInteger(errorRecord.code) ||
        typeof errorRecord.message !== 'string' || !errorRecord.message) {
      throw new Error('进程插件 error 缺少 code 或 message');
    }
  }
}
