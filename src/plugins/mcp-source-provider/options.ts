import type { PluginJsonObject, PluginJsonValue } from '../../contracts/json.js';

const ENTRY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOURCE_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const OPTION_KEYS = new Set([
  'allowInsecureHttp',
  'endpoint',
  'maxTextChars',
  'routes',
  'sourceType',
  'timeoutMs',
  'tokenEnv',
]);
const ROUTE_KEYS = new Set([
  'referenceArgument',
  'referencePattern',
  'staticArguments',
  'tool',
]);

export interface McpSourceRoute {
  readonly referenceArgument?: string;
  readonly referencePattern?: string;
  readonly staticArguments?: Readonly<Record<string, PluginJsonValue>>;
  readonly tool: string;
}

export interface McpSourceProviderOptions {
  readonly allowInsecureHttp: boolean;
  readonly endpoint: URL;
  readonly maxTextChars: number;
  readonly routes: Readonly<Record<string, McpSourceRoute>>;
  readonly sourceType: string;
  readonly timeoutMs: number;
  readonly tokenEnv: string;
}

const isObject = (value: unknown): value is Readonly<PluginJsonObject> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (
  value: PluginJsonValue | undefined,
  path: string,
  maximumLength = 256,
): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${path} 必须是非空字符串`);
  }
  const result = value.trim();
  if (result.length > maximumLength) {
    throw new Error(`${path} 不能超过 ${maximumLength} 个字符`);
  }
  return result;
};

const boundedInteger = (
  value: PluginJsonValue | undefined,
  path: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || typeof value !== 'number' ||
      value < minimum || value > maximum) {
    throw new Error(`${path} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
};

const rejectUnknownKeys = (
  value: Readonly<PluginJsonObject>,
  keys: ReadonlySet<string>,
  path: string,
): void => {
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path} 包含未知字段：${unknown.join(', ')}`);
  }
};

const readStaticArguments = (
  value: PluginJsonValue | undefined,
  path: string,
): Readonly<Record<string, PluginJsonValue>> | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error(`${path} 必须是 JSON 对象`);
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, PluginJsonValue] => entry[1] !== undefined,
  );
  return Object.freeze(Object.fromEntries(entries));
};

const readRoute = (entry: string, value: PluginJsonValue | undefined): McpSourceRoute => {
  const path = `routes.${entry}`;
  if (!ENTRY_PATTERN.test(entry)) {
    throw new Error(`非法 Entry：${entry}`);
  }
  if (!isObject(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  rejectUnknownKeys(value, ROUTE_KEYS, path);
  const tool = requiredString(value.tool, `${path}.tool`, 128);
  const referenceArgument = value.referenceArgument === undefined
    ? undefined
    : requiredString(value.referenceArgument, `${path}.referenceArgument`, 128);
  const referencePattern = value.referencePattern === undefined
    ? undefined
    : requiredString(value.referencePattern, `${path}.referencePattern`, 512);
  if (referencePattern) {
    try {
      new RegExp(referencePattern);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${path}.referencePattern 不是有效正则表达式：${message}`);
    }
  }
  const staticArguments = readStaticArguments(value.staticArguments, `${path}.staticArguments`);
  return Object.freeze({
    ...(referenceArgument ? { referenceArgument } : {}),
    ...(referencePattern ? { referencePattern } : {}),
    ...(staticArguments ? { staticArguments } : {}),
    tool,
  });
};

/** 在访问网络或凭据前校验 JSON 信任边界。 */
export const parseMcpSourceProviderOptions = (
  value: Readonly<PluginJsonObject>,
): McpSourceProviderOptions => {
  rejectUnknownKeys(value, OPTION_KEYS, 'mcp-source-provider.options');
  const endpointValue = requiredString(value.endpoint, 'endpoint', 2_048);
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error('endpoint 必须是有效 URL');
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new Error('endpoint 只支持 https 或 http');
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('endpoint 禁止包含凭据');
  }
  const allowInsecureHttp = value.allowInsecureHttp === true;
  if (value.allowInsecureHttp !== undefined && typeof value.allowInsecureHttp !== 'boolean') {
    throw new Error('allowInsecureHttp 必须是布尔值');
  }
  if (endpoint.protocol === 'http:' && !allowInsecureHttp) {
    throw new Error('HTTP 会明文传输凭据；仅受信内网可显式设置 allowInsecureHttp: true');
  }

  const routesValue = value.routes;
  if (!isObject(routesValue) || Object.keys(routesValue).length === 0) {
    throw new Error('routes 必须是至少包含一个 Entry 的对象');
  }
  const routes = Object.freeze(Object.fromEntries(
    Object.entries(routesValue).map(([entry, route]) => [entry, readRoute(entry, route)]),
  ));
  const tokenEnv = value.tokenEnv === undefined
    ? 'AGENT_WORKFLOW_MCP_TOKEN'
    : requiredString(value.tokenEnv, 'tokenEnv', 128);
  if (!ENVIRONMENT_NAME_PATTERN.test(tokenEnv)) {
    throw new Error('tokenEnv 必须是合法环境变量名');
  }
  const sourceType = value.sourceType === undefined
    ? 'mcp'
    : requiredString(value.sourceType, 'sourceType', 64);
  if (!SOURCE_TYPE_PATTERN.test(sourceType)) {
    throw new Error('sourceType 必须以小写字母开头，且只能包含小写字母、数字、点、下划线和连字符');
  }
  return Object.freeze({
    allowInsecureHttp,
    endpoint,
    maxTextChars: boundedInteger(value.maxTextChars, 'maxTextChars', 50_000, 1_000, 200_000),
    routes,
    sourceType,
    timeoutMs: boundedInteger(value.timeoutMs, 'timeoutMs', 60_000, 1_000, 120_000),
    tokenEnv,
  });
};
