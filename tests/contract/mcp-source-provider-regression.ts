import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  createMcpSourceProvider,
  default as mcpSourcePlugin,
  parseMcpSourceProviderOptions,
  type McpSourceConnection,
  type McpSourceConnector,
} from '../../src/plugins/mcp-source-provider/index.js';
import type { SourceProviderService } from '../../src/contracts/capabilities.js';
import type { PluginJsonObject } from '../../src/contracts/json.js';
import { loadWorkflowProfile } from '../../src/config/workflow-config.js';
import {
  readSourceCaptureArguments,
  resolveSourceProviderId,
  selectSourceProvider,
} from '../../src/host-node/source-capture-cli.js';
import { WorkflowPluginRuntime } from '../../src/host-node/index.js';
import { errorMessage } from '../../src/types/guards.js';

const providerOptions = (): PluginJsonObject => ({
  allowInsecureHttp: true,
  endpoint: 'http://mcp.example.test/service',
  maxTextChars: 10_000,
  routes: {
    defect: {
      referenceArgument: 'bugCode',
      referencePattern: '^BG',
      staticArguments: { includeHistory: true },
      tool: 'query_bug',
    },
    requirement: {
      referencePattern: '^XQ',
      tool: 'query_requirement',
    },
  },
  sourceType: 'test-mcp',
  timeoutMs: 5_000,
  tokenEnv: 'TEST_MCP_TOKEN',
});

const validationContract = (): void => {
  assert.deepEqual(
    parseMcpSourceProviderOptions({
      endpoint: 'https://mcp.example.test/service',
      auth: { type: 'file', path: 'C:\\Users\\test\\.config\\mcp.token' },
      routes: { requirement: { tool: 'query_requirement' } },
    }).auth,
    { type: 'file', path: 'C:\\Users\\test\\.config\\mcp.token' },
  );
  assert.deepEqual(
    parseMcpSourceProviderOptions({
      endpoint: 'https://mcp.example.test/service',
      auth: { type: 'command', command: 'mcp-credential-helper', args: ['token'] },
      routes: { requirement: { tool: 'query_requirement' } },
    }).auth,
    { type: 'command', command: 'mcp-credential-helper', args: ['token'] },
  );
  assert.deepEqual(
    parseMcpSourceProviderOptions({
      endpoint: 'https://mcp.example.test/service',
      auth: { type: 'credential-store', profile: 'project-default' },
      routes: { requirement: { tool: 'query_requirement' } },
    }).auth,
    { type: 'credential-store', profile: 'project-default' },
  );
  assert.throws(() => parseMcpSourceProviderOptions({
    endpoint: 'https://mcp.example.test/service',
    auth: { type: 'file', path: '.secrets/mcp.token' },
    routes: { requirement: { tool: 'query_requirement' } },
  }), /绝对路径/);
  assert.throws(() => parseMcpSourceProviderOptions({
    endpoint: 'https://mcp.example.test/service',
    auth: { type: 'file', path: 'C:\\Users\\test\\mcp.token' },
    tokenEnv: 'TEST_MCP_TOKEN',
    routes: { requirement: { tool: 'query_requirement' } },
  }), /不能同时配置/);
  assert.throws(() => parseMcpSourceProviderOptions({
    endpoint: 'http://mcp.example.test/service',
    routes: { requirement: { tool: 'query_requirement' } },
  }), /allowInsecureHttp/);
  assert.throws(() => parseMcpSourceProviderOptions({
    endpoint: 'https://user:password@mcp.example.test/service',
    routes: { requirement: { tool: 'query_requirement' } },
  }), /禁止包含凭据/);
  assert.throws(() => parseMcpSourceProviderOptions({
    endpoint: 'https://mcp.example.test/service',
    routes: { requirement: { unexpected: true, tool: 'query_requirement' } },
  }), /未知字段/);
};

const captureContract = async (): Promise<void> => {
  let closeCount = 0;
  let connectCount = 0;
  let listCount = 0;
  const calls: Array<{ arguments: Readonly<Record<string, unknown>>; name: string }> = [];
  const connection: McpSourceConnection = {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'query_requirement') {
        return {
          content: [
            {
              type: 'text',
              text: '{"api_key":"exposed-api-key","authorization":"Bearer exposed-bearer","screenshot":"https://files.example.test/a.png?OSSAccessKeyId=test&Signature=secret","status":"待处理","title":"需求标题"}',
            },
            { type: 'image', data: 'excluded-binary-content' },
          ],
          structuredContent: {
            nested: { password: 'exposed-password' },
            owner: '示例负责人',
            token: 'exposed-token',
          },
          isError: false,
          _meta: { requestId: 'request-123' },
        };
      }
      return {
        content: [{ type: 'text', text: '缺陷详情' }],
      };
    },
    async close() {
      closeCount += 1;
    },
    async listTools() {
      listCount += 1;
      return [
        {
          inputSchema: {
            properties: { sn: { type: 'string' } },
            required: ['sn'],
            type: 'object',
          },
          name: 'query_requirement',
        },
        {
          inputSchema: {
            properties: {
              bugCode: { type: 'string' },
              includeHistory: { type: 'boolean' },
            },
            required: ['bugCode'],
            type: 'object',
          },
          name: 'query_bug',
        },
      ];
    },
  };
  const connect: McpSourceConnector = async (options) => {
    connectCount += 1;
    assert.equal(options.endpoint.href, 'http://mcp.example.test/service');
    assert.equal(await options.readToken(), 'test-token-not-a-secret');
    assert.equal(options.timeoutMs, 5_000);
    return connection;
  };
  const provider = createMcpSourceProvider(providerOptions(), {
    connect,
    environment: { TEST_MCP_TOKEN: 'Bearer test-token-not-a-secret' },
    now: () => new Date('2026-08-21T00:00:00.000Z'),
  });
  const requirement = await provider.capture({
    entry: 'pool',
    reference: 'XQ123456',
  });
  assert.equal(requirement.capturedAt, '2026-08-21T00:00:00.000Z');
  assert.equal(requirement.sourceId, 'requirement:XQ123456');
  assert.equal(requirement.sourceType, 'test-mcp');
  assert.deepEqual(requirement.facts.result, {
    api_key: 'exposed-api-key',
    authorization: 'Bearer exposed-bearer',
    screenshot: 'https://files.example.test/a.png?OSSAccessKeyId=test&Signature=secret',
    status: '待处理',
    title: '需求标题',
  });
  assert.deepEqual(requirement.facts.content, [
    {
      type: 'text',
      text: '{"api_key":"exposed-api-key","authorization":"Bearer exposed-bearer","screenshot":"https://files.example.test/a.png?OSSAccessKeyId=test&Signature=secret","status":"待处理","title":"需求标题"}',
    },
    { type: 'image', data: 'excluded-binary-content' },
  ]);
  assert.equal(requirement.facts.isError, false);
  assert.deepEqual(requirement.facts.mcpResult, {
    content: [
      {
        type: 'text',
        text: '{"api_key":"exposed-api-key","authorization":"Bearer exposed-bearer","screenshot":"https://files.example.test/a.png?OSSAccessKeyId=test&Signature=secret","status":"待处理","title":"需求标题"}',
      },
      { type: 'image', data: 'excluded-binary-content' },
    ],
    structuredContent: {
      nested: { password: 'exposed-password' },
      owner: '示例负责人',
      token: 'exposed-token',
    },
    isError: false,
    _meta: { requestId: 'request-123' },
  });
  assert.match(JSON.stringify(requirement), /Signature=secret/);
  assert.deepEqual(requirement.facts.structuredContent, {
    nested: { password: 'exposed-password' },
    owner: '示例负责人',
    token: 'exposed-token',
  });
  assert.match(JSON.stringify(requirement), /exposed-(?:api-key|bearer|password|token)/);
  assert.match(JSON.stringify(requirement), /excluded-binary-content/);

  const defect = await provider.capture({ entry: 'pool', reference: 'BG654321' });
  assert.equal(defect.facts.result, '缺陷详情');
  assert.deepEqual(calls, [
    { arguments: { sn: 'XQ123456' }, name: 'query_requirement' },
    {
      arguments: { bugCode: 'BG654321', includeHistory: true },
      name: 'query_bug',
    },
  ]);
  assert.equal(connectCount, 1);
  assert.equal(listCount, 1);
  await assert.rejects(
    provider.capture({ entry: 'defect', reference: 'XQ-invalid' }),
    /referencePattern/,
  );
  await assert.rejects(
    provider.capture({ entry: 'pool', reference: 'UNKNOWN' }),
    /没有 referencePattern 匹配/,
  );
  await provider.close();
  await provider.close();
  assert.equal(closeCount, 1);
  await assert.rejects(
    provider.capture({ entry: 'requirement', reference: 'XQ123456' }),
    /已关闭/,
  );
};

const failureContract = async (): Promise<void> => {
  const missingSecret = createMcpSourceProvider(providerOptions(), {
    connect: async (options) => {
      await options.readToken();
      throw new Error('Connector 不应继续执行');
    },
    environment: {},
  });
  await assert.rejects(
    missingSecret.capture({ entry: 'requirement', reference: 'XQ123456' }),
    /TEST_MCP_TOKEN/,
  );
  await missingSecret.close();

  let closeCount = 0;
  const ambiguous = createMcpSourceProvider(providerOptions(), {
    connect: async () => ({
      async callTool() {
        throw new Error('Schema 存在歧义时应在 callTool 前失败');
      },
      async close() {
        closeCount += 1;
      },
      async listTools() {
        return [{
          inputSchema: {
            properties: {
              left: { type: 'string' },
              right: { type: 'string' },
            },
            type: 'object',
          },
          name: 'query_requirement',
        }];
      },
    }),
    environment: { TEST_MCP_TOKEN: 'test-token-not-a-secret' },
  });
  await assert.rejects(
    ambiguous.capture({ entry: 'requirement', reference: 'XQ123456' }),
    /referenceArgument/,
  );
  await ambiguous.close();
  assert.equal(closeCount, 1);

  const toolFailure = createMcpSourceProvider(providerOptions(), {
    connect: async () => ({
      async callTool() {
        return {
          content: [{
            type: 'text',
            text: '未找到 Authorization: Bearer exposed-credential authorization=raw-secret api_key=exposed-api-key',
          }],
          isError: true,
        };
      },
      async close() {},
      async listTools() {
        return [{
          inputSchema: {
            properties: { sn: { type: 'string' } },
            required: ['sn'],
          },
          name: 'query_requirement',
        }];
      },
    }),
    environment: { TEST_MCP_TOKEN: 'test-token-not-a-secret' },
  });
  await assert.rejects(
    toolFailure.capture({ entry: 'requirement', reference: 'XQ123456' }),
    (error: Error) => {
      assert.match(error.message, /未找到/);
      assert.match(error.message, /exposed-(?:credential|api-key)|raw-secret/);
      return true;
    },
  );
  await toolFailure.close();

  let routeConnectCount = 0;
  const ambiguousRoute = createMcpSourceProvider({
    ...providerOptions(),
    routes: {
      requirement: {
        referencePattern: '^XQ',
        tool: 'query_requirement',
      },
      'requirement-alias': {
        referencePattern: '^XQ',
        tool: 'query_requirement',
      },
    },
  }, {
    connect: async () => {
      routeConnectCount += 1;
      throw new Error('路由存在歧义时应在连接前失败');
    },
    environment: { TEST_MCP_TOKEN: 'test-token-not-a-secret' },
  });
  await assert.rejects(
    ambiguousRoute.capture({ entry: 'pool', reference: 'XQ123456' }),
    /同时匹配多个 Route/,
  );
  assert.equal(routeConnectCount, 0);
  await ambiguousRoute.close();
};

const cliContract = (): void => {
  assert.deepEqual(readSourceCaptureArguments([
    '--entry', 'requirement',
    '--reference', 'XQ123456',
    '--format', 'json',
  ]), {
    entry: 'requirement',
    format: 'json',
    providerId: '',
    reference: 'XQ123456',
  });
  assert.throws(() => readSourceCaptureArguments(['--entry', 'requirement']), /reference/);
  assert.throws(() => readSourceCaptureArguments(['--unknown', 'value']), /未知参数/);

  const first: SourceProviderService = {
    id: 'first',
    async capture() {
      throw new Error('不应调用');
    },
  };
  const second: SourceProviderService = { ...first, id: 'second' };
  assert.equal(selectSourceProvider([first], ''), first);
  assert.equal(selectSourceProvider([first, second], 'second'), second);
  assert.throws(() => selectSourceProvider([first, second], ''), /多个/);

  const profile = loadWorkflowProfile('workflow:resources/profiles/default/profile.json');
  assert.equal(resolveSourceProviderId(profile, 'pool', ''), 'project-source-provider');
  assert.equal(resolveSourceProviderId(profile, 'pool', 'second'), 'second');
  assert.throws(
    () => resolveSourceProviderId(profile, 'direct', ''),
    /不是可执行 Connector/,
  );
  assert.throws(
    () => resolveSourceProviderId(profile, 'missing', ''),
    /未绑定 Entry/,
  );
};

const pluginLifecycleContract = async (): Promise<void> => {
  const host = new WorkflowPluginRuntime({
    plugins: [{
      configuration: {
        id: 'mcp-source-provider',
        module: '@gk0919/agent-workflow/plugins/mcp-source-provider',
        options: providerOptions(),
        permissions: ['network:connect', 'secrets:read'],
      },
      plugin: mcpSourcePlugin,
    }],
  });
  await host.start();
  assert.equal(host.state, 'running');
  await host.stop();
  assert.equal(host.state, 'idle');
};

/** 覆盖选项校验、凭据隔离、Schema 推断、生命周期和 CLI 选择。 */
export const main = async (): Promise<number> => {
  try {
    validationContract();
    await captureContract();
    await failureContract();
    cliContract();
    await pluginLifecycleContract();
    process.stdout.write(
      'MCP source-provider 回归通过：配置、凭据、工具映射、输出边界、生命周期与 CLI 正常。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`MCP source-provider 回归失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
