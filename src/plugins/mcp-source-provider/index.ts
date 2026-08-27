import process from 'node:process';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
} from '@modelcontextprotocol/client';
import type {
  SourceCaptureRequest,
  SourceCaptureResult,
  SourceProviderService,
} from '../../contracts/capabilities.js';
import type { PluginJsonObject, PluginJsonValue } from '../../contracts/json.js';
import {
  definePlugin,
  sourceProviderService,
} from '../../plugin-sdk/index.js';
import {
  parseMcpSourceProviderOptions,
  type McpSourceProviderOptions,
  type McpSourceProviderAuth,
  type McpSourceRoute,
} from './options.js';
import {
  toSourceCaptureResult,
  type McpSourceToolResult,
} from './result.js';

export interface McpSourceTool {
  readonly inputSchema?: unknown;
  readonly name: string;
}

export interface McpSourceToolRequest {
  readonly arguments: Readonly<Record<string, PluginJsonValue>>;
  readonly name: string;
}

export interface McpSourceConnection {
  callTool(request: McpSourceToolRequest, timeoutMs: number): Promise<McpSourceToolResult>;
  close(): Promise<void>;
  listTools(timeoutMs: number): Promise<readonly McpSourceTool[]>;
}

export interface McpSourceConnectionOptions {
  readonly endpoint: URL;
  readonly readToken: () => Promise<string>;
  readonly timeoutMs: number;
}

export type McpSourceConnector = (
  options: McpSourceConnectionOptions,
) => Promise<McpSourceConnection>;

export interface McpSourceProviderDependencies {
  readonly connect?: McpSourceConnector;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const closeClient = async (
  client: Client,
  transport: StreamableHTTPClientTransport,
): Promise<void> => {
  let terminationFailure: unknown;
  try {
    if (transport.sessionId) {
      await transport.terminateSession();
    }
  } catch (error: unknown) {
    terminationFailure = error;
  }
  try {
    await client.close();
  } catch (error: unknown) {
    if (terminationFailure) {
      throw new AggregateError([terminationFailure, error], 'MCP session 终止和连接关闭均失败');
    }
    throw error;
  }
  if (terminationFailure) {
    throw terminationFailure;
  }
};

/** 使用官方 MCP TypeScript 客户端和 Streamable HTTP 传输。 */
export const connectMcpSource: McpSourceConnector = async (options) => {
  const authProvider: AuthProvider = {
    token: async () => options.readToken(),
  };
  const client = new Client({
    name: 'agent-workflow-mcp-source-provider',
    version: '1.0.0',
  });
  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    authProvider,
    onInsufficientScope: 'throw',
  });
  try {
    await client.connect(transport, { timeout: options.timeoutMs });
  } catch (error: unknown) {
    try {
      await client.close();
    } catch (closeError: unknown) {
      throw new AggregateError([error, closeError], 'MCP 连接和清理均失败');
    }
    throw error;
  }
  let closed = false;
  return {
    async callTool(request, timeoutMs) {
      const result = await client.callTool({
        arguments: request.arguments,
        name: request.name,
      }, { timeout: timeoutMs });
      return result;
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await closeClient(client, transport);
    },
    async listTools(timeoutMs) {
      const { tools } = await client.listTools(undefined, { timeout: timeoutMs });
      return tools.map(({ inputSchema, name }) => ({ inputSchema, name }));
    },
  };
};

const readBearerToken = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string => {
  const configured = environment[name]?.trim();
  if (!configured) {
    throw new Error(`缺少 MCP 凭据环境变量：${name}`);
  }
  const token = configured.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw new Error(`MCP 凭据环境变量为空：${name}`);
  }
  return token;
};

const readTokenText = (value: string, source: string): string => {
  const configured = value.trim();
  if (!configured) {
    throw new Error(`MCP 凭据为空：${source}`);
  }
  if (configured.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(configured);
      if (isObject(parsed)) {
        const token = parsed.access_token ?? parsed.accessToken ?? parsed.token;
        if (typeof token === 'string' && token.trim()) {
          return token.trim().replace(/^Bearer\s+/i, '').trim();
        }
      }
    } catch {
      throw new Error(`MCP 凭据命令返回了无效 JSON：${source}`);
    }
  }
  return configured.replace(/^Bearer\s+/i, '').trim();
};

const execFile = promisify(execFileCallback);

const readCredentialStoreToken = async (
  profile: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> => {
  const configRoot = process.platform === 'win32'
    ? environment.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : environment.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const filePath = path.join(configRoot, 'mcp-credentials', 'credentials.json');
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null ||
        !('version' in parsed) || parsed.version !== 1 ||
        !('profiles' in parsed) || typeof parsed.profiles !== 'object' ||
        parsed.profiles === null || Array.isArray(parsed.profiles)) {
      throw new Error('format');
    }
    const record = (parsed.profiles as Record<string, unknown>)[profile];
    if (typeof record !== 'object' || record === null ||
        !('token' in record) || typeof record.token !== 'string' || !record.token.trim()) {
      throw new Error('missing');
    }
    return record.token.trim().replace(/^Bearer\s+/i, '').trim();
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'missing') {
      throw new Error(`未找到 profile：${profile}`);
    }
    throw new Error(`凭据存储读取失败：${filePath}`);
  }
};

const readConfiguredToken = async (
  auth: McpSourceProviderAuth,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<string> => {
  if (auth.type === 'environment') {
    return readBearerToken(environment, auth.env);
  }
  if (auth.type === 'file') {
    try {
      return readTokenText(await readFile(auth.path, 'utf8'), `auth.path ${auth.path}`);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('MCP 凭据')) {
        throw error;
      }
      throw new Error(`读取 MCP 凭据文件失败：${auth.path}`);
    }
  }
  if (auth.type === 'credential-store') {
    return readCredentialStoreToken(auth.profile, environment);
  }
  try {
    const result = await execFile(auth.command, [...auth.args], {
      env: { ...environment },
      timeout: timeoutMs,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    return readTokenText(result.stdout, `auth.command ${auth.command}`);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('MCP 凭据')) {
      throw error;
    }
    throw new Error(`读取 MCP 凭据命令失败：${auth.command}`);
  }
};

const schemaProperties = (schema: unknown): Readonly<Record<string, unknown>> => {
  if (!isObject(schema) || !isObject(schema.properties)) {
    return {};
  }
  return schema.properties;
};

const stringPropertyNames = (schema: unknown): string[] => Object.entries(schemaProperties(schema))
  .filter(([, definition]) => !isObject(definition) ||
    definition.type === undefined || definition.type === 'string')
  .map(([name]) => name);

const requiredPropertyNames = (schema: unknown): string[] => {
  if (!isObject(schema) || !Array.isArray(schema.required)) {
    return [];
  }
  return schema.required.filter((name): name is string => typeof name === 'string');
};

const PREFERRED_REFERENCE_ARGUMENTS = [
  'sn',
  'id',
  'code',
  'number',
  'reference',
  'requirementNo',
  'bugNo',
] as const;

const selectReferenceArgument = (tool: McpSourceTool, route: McpSourceRoute): string => {
  const properties = stringPropertyNames(tool.inputSchema);
  if (route.referenceArgument) {
    if (properties.length > 0 && !properties.includes(route.referenceArgument)) {
      throw new Error(
        `工具 ${tool.name} 的 inputSchema 不包含配置参数 ${route.referenceArgument}`,
      );
    }
    return route.referenceArgument;
  }
  const required = requiredPropertyNames(tool.inputSchema)
    .filter((name) => properties.includes(name));
  if (required.length === 1) {
    return required[0] as string;
  }
  const preferred = PREFERRED_REFERENCE_ARGUMENTS.find((name) => properties.includes(name));
  if (preferred) {
    return preferred;
  }
  if (properties.length === 1) {
    return properties[0] as string;
  }
  throw new Error(
    `无法从工具 ${tool.name} 推断编号参数` +
    `${properties.length > 0 ? `（可选：${properties.join(', ')}）` : ''}，` +
    '请在 route 中配置 referenceArgument',
  );
};

const selectRoute = (
  routes: Readonly<Record<string, McpSourceRoute>>,
  requestedEntry: string,
  reference: string,
): { entry: string; route: McpSourceRoute } => {
  const exactRoute = routes[requestedEntry];
  if (exactRoute) {
    if (exactRoute.referencePattern &&
        !new RegExp(exactRoute.referencePattern).test(reference)) {
      throw new Error(
        `reference 不符合 Entry ${requestedEntry} 的 referencePattern`,
      );
    }
    return { entry: requestedEntry, route: exactRoute };
  }

  // Profile 可以声明逻辑 Entry；编号匹配规则归 Adapter 所有，且必须唯一解析到一个 Route。
  const matches = Object.entries(routes).filter(([, route]) =>
    route.referencePattern && new RegExp(route.referencePattern).test(reference));
  if (matches.length === 0) {
    throw new Error(
      `未配置 Entry：${requestedEntry}，且没有 referencePattern 匹配该 reference`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      'reference 同时匹配多个 Route：' +
      matches.map(([entry]) => entry).join(', '),
    );
  }
  const [entry, route] = matches[0] as [string, McpSourceRoute];
  return { entry, route };
};

class McpSourceProvider implements SourceProviderService {
  readonly id = 'mcp-source-provider';
  readonly #activeCaptures = new Set<Promise<SourceCaptureResult>>();
  readonly #connect: McpSourceConnector;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #now: () => Date;
  readonly #options: McpSourceProviderOptions;
  #closePromise: Promise<void> | undefined;
  #connectionPromise: Promise<McpSourceConnection> | undefined;
  #toolsPromise: Promise<readonly McpSourceTool[]> | undefined;
  #closed = false;

  constructor(
    options: Readonly<PluginJsonObject>,
    dependencies: McpSourceProviderDependencies = {},
  ) {
    this.#options = parseMcpSourceProviderOptions(options);
    this.#connect = dependencies.connect ?? connectMcpSource;
    this.#environment = dependencies.environment ?? process.env;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async #connection(): Promise<McpSourceConnection> {
    if (this.#closed) {
      throw new Error('mcp-source-provider 已关闭');
    }
    this.#connectionPromise ??= this.#connect({
      endpoint: this.#options.endpoint,
      readToken: () => readConfiguredToken(
        this.#options.auth,
        this.#environment,
        this.#options.timeoutMs,
      ),
      timeoutMs: this.#options.timeoutMs,
    }).catch((error: unknown) => {
      this.#connectionPromise = undefined;
      throw error;
    });
    return this.#connectionPromise;
  }

  async #capture(request: SourceCaptureRequest): Promise<SourceCaptureResult> {
    const entry = request.entry.trim();
    const reference = request.reference?.trim();
    if (!entry) {
      throw new Error('Entry 不能为空');
    }
    if (!reference) {
      throw new Error(`Entry ${entry} 必须提供 reference`);
    }
    if (reference.length > 512) {
      throw new Error('reference 不能超过 512 个字符');
    }
    const selected = selectRoute(this.#options.routes, entry, reference);
    const route = selected.route;
    const connection = await this.#connection();
    this.#toolsPromise ??= connection.listTools(this.#options.timeoutMs).catch(
      (error: unknown) => {
        this.#toolsPromise = undefined;
        throw error;
      },
    );
    const tools = await this.#toolsPromise;
    const tool = tools.find(({ name }) => name === route.tool);
    if (!tool) {
      throw new Error(`MCP 服务未提供已配置工具：${route.tool}`);
    }
    const referenceArgument = selectReferenceArgument(tool, route);
    const result = await connection.callTool({
      arguments: Object.freeze({
        ...route.staticArguments,
        [referenceArgument]: reference,
      }),
      name: route.tool,
    }, this.#options.timeoutMs);
    return toSourceCaptureResult(result, {
      entry: selected.entry,
      maxTextChars: this.#options.maxTextChars,
      now: this.#now,
      reference,
      sourceType: this.#options.sourceType,
      tool: route.tool,
    });
  }

  capture(request: SourceCaptureRequest): Promise<SourceCaptureResult> {
    if (this.#closed) {
      return Promise.reject(new Error('mcp-source-provider 已关闭'));
    }
    const operation = this.#capture(request);
    this.#activeCaptures.add(operation);
    void operation.finally(() => this.#activeCaptures.delete(operation)).catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#closed = true;
      await Promise.allSettled(this.#activeCaptures);
      const connection = await this.#connectionPromise?.catch(() => undefined);
      await connection?.close();
    })();
    return this.#closePromise;
  }
}

/** 创建无需激活插件宿主即可独立测试的 Provider。 */
export const createMcpSourceProvider = (
  options: Readonly<PluginJsonObject>,
  dependencies: McpSourceProviderDependencies = {},
): SourceProviderService & { close(): Promise<void> } =>
  new McpSourceProvider(options, dependencies);

const plugin = definePlugin({
  manifest: {
    apiVersion: 1,
    capabilities: ['source-provider'],
    description: '通过 MCP 服务捕获精确的需求或缺陷编号。',
    id: 'mcp-source-provider',
    permissions: ['network:connect', 'secrets:read'],
    provides: { services: [sourceProviderService.id] },
    version: '1.0.0',
  },
  setup(context) {
    const provider = createMcpSourceProvider(context.options);
    context.provide(sourceProviderService, provider);
    return () => provider.close();
  },
});

export default plugin;
export { parseMcpSourceProviderOptions } from './options.js';
export type { McpSourceProviderOptions, McpSourceRoute } from './options.js';
