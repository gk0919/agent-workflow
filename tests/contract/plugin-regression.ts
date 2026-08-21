import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { WorkflowPlugin } from '../../src/contracts/plugin.js';
import {
  createPluginRpcRequest,
  assertPluginRpcResponse,
} from '../../src/host-rpc/index.js';
import {
  createNodePluginHost,
  loadNodePlugins,
  WorkflowPluginRuntime,
} from '../../src/host-node/index.js';
import {
  definePlugin,
  defineService,
  sourceProviderService,
} from '../../src/plugin-sdk/index.js';
import { loadWorkflowConfig, validateWorkflowConfig } from '../../src/config/workflow-config.js';
import { workspaceRoot } from '../../src/config/workspace-paths.js';
import { errorMessage } from '../../src/types/guards.js';

const valueService = defineService<string>('test/value');
const secureService = defineService<string>('test/secure', {
  permission: 'workspace:read',
});

const configuration = (
  id: string,
  permissions: readonly ('workspace:read')[] = [],
) => ({
  id,
  module: `@fixture/${id}`,
  permissions,
});

const lifecycleContract = async (): Promise<void> => {
  const events: string[] = [];
  const provider = definePlugin({
    manifest: {
      apiVersion: 1,
      capabilities: ['context-provider'],
      id: 'value-provider',
      provides: { services: [valueService.id] },
      version: '1.0.0',
    },
    async setup(context) {
      events.push('provider:setup');
      context.provide(valueService, 'ready');
      context.on('plugin:activated', ({ pluginId }) => {
        events.push(`activated:${pluginId}`);
      });
      context.on('command:before', ({ command }) => {
        events.push(`command:${command}`);
      });
      await context.effect(() => {
        events.push('effect-one:setup');
        return () => {
          events.push('effect-one:cleanup');
        };
      });
      await context.effect(() => {
        events.push('effect-two:setup');
        return () => {
          events.push('effect-two:cleanup');
        };
      });
      return () => {
        events.push('provider:return-cleanup');
      };
    },
  });
  const consumer = definePlugin({
    manifest: {
      apiVersion: 1,
      capabilities: ['validator'],
      id: 'value-consumer',
      requires: {
        plugins: ['value-provider'],
        services: [valueService.id],
      },
      version: '1.0.0',
    },
    setup(context) {
      events.push(`consumer:${context.get(valueService)}`);
      return () => {
        events.push('consumer:cleanup');
      };
    },
  });
  const host = new WorkflowPluginRuntime({
    // Reverse declaration order proves that dependencies, not config order, drive activation.
    plugins: [
      { configuration: configuration('value-consumer'), plugin: consumer },
      { configuration: configuration('value-provider'), plugin: provider },
    ],
  });

  await host.start();
  assert.equal(host.state, 'running');
  assert.equal(host.getService(valueService), 'ready');
  assert.deepEqual(host.status().map(({ id, state }) => [id, state]), [
    ['value-provider', 'active'],
    ['value-consumer', 'active'],
  ]);
  assert.deepEqual(events, [
    'provider:setup',
    'effect-one:setup',
    'effect-two:setup',
    'activated:value-provider',
    'consumer:ready',
    'activated:value-consumer',
  ]);
  await host.emit('command:before', { command: 'route' });
  assert.equal(events.at(-1), 'command:route');

  await host.stop();
  assert.equal(host.state, 'idle');
  assert.deepEqual(events.slice(-4), [
    'consumer:cleanup',
    'provider:return-cleanup',
    'effect-two:cleanup',
    'effect-one:cleanup',
  ]);
  assert.deepEqual(host.getServices(valueService), []);
};

const permissionContract = async (): Promise<void> => {
  const secureConsumer = definePlugin({
    manifest: {
      apiVersion: 1,
      capabilities: ['validator'],
      id: 'secure-consumer',
      permissions: ['workspace:read'],
      requires: { services: [secureService.id] },
      version: '1.0.0',
    },
    setup(context) {
      assert.equal(context.get(secureService), 'protected');
    },
  });
  assert.throws(() => new WorkflowPluginRuntime({
    plugins: [{
      configuration: configuration('secure-consumer'),
      plugin: secureConsumer,
    }],
    services: [{ service: secureService, value: 'protected' }],
  }), /缺少权限授权/);

  const host = new WorkflowPluginRuntime({
    plugins: [{
      configuration: configuration('secure-consumer', ['workspace:read']),
      plugin: secureConsumer,
    }],
    services: [{ service: secureService, value: 'protected' }],
  });
  await host.start();
  await host.stop();
};

const rollbackContract = async (): Promise<void> => {
  const events: string[] = [];
  const provider = definePlugin({
    manifest: {
      apiVersion: 1,
      capabilities: ['context-provider'],
      id: 'rollback-provider',
      provides: { services: [valueService.id] },
      version: '1.0.0',
    },
    setup(context) {
      context.provide(valueService, 'temporary');
      return () => {
        events.push('provider:rollback');
      };
    },
  });
  const failing = definePlugin({
    manifest: {
      apiVersion: 1,
      capabilities: ['validator'],
      id: 'rollback-failure',
      requires: { services: [valueService.id] },
      version: '1.0.0',
    },
    async setup(context) {
      assert.equal(context.get(valueService), 'temporary');
      await context.effect(() => () => {
        events.push('failure:rollback');
      });
      throw new Error('intentional setup failure');
    },
  });
  const host = new WorkflowPluginRuntime({
    plugins: [
      { configuration: configuration('rollback-failure'), plugin: failing },
      { configuration: configuration('rollback-provider'), plugin: provider },
    ],
  });
  await assert.rejects(host.start(), /intentional setup failure/);
  assert.equal(host.state, 'idle');
  assert.deepEqual(events, ['failure:rollback', 'provider:rollback']);
  assert.deepEqual(host.getServices(valueService), []);

  let activationCleanupCount = 0;
  const eventFailure = definePlugin({
    manifest: {
      apiVersion: 1,
      capabilities: ['reporter'],
      id: 'event-failure',
      version: '1.0.0',
    },
    setup(context) {
      context.on('plugin:activated', () => {
        throw new Error('activation event failure');
      });
      return () => {
        activationCleanupCount += 1;
      };
    },
  });
  const eventFailureHost = new WorkflowPluginRuntime({
    plugins: [{
      configuration: configuration('event-failure'),
      plugin: eventFailure,
    }],
  });
  await assert.rejects(eventFailureHost.start(), /activation event failure/);
  assert.equal(activationCleanupCount, 1);
  assert.equal(eventFailureHost.state, 'idle');
};

const declarationContract = async (): Promise<void> => {
  const undeclaredProvider = definePlugin({
    manifest: {
      apiVersion: 1,
      capabilities: ['context-provider'],
      id: 'undeclared-provider',
      version: '1.0.0',
    },
    setup(context) {
      context.provide(valueService, 'invalid');
    },
  });
  const host = new WorkflowPluginRuntime({
    plugins: [{
      configuration: configuration('undeclared-provider'),
      plugin: undeclaredProvider,
    }],
  });
  await assert.rejects(host.start(), /未在 provides.services 声明/);
  assert.equal(host.state, 'idle');

  const mismatchedCapability = definePlugin({
    manifest: {
      apiVersion: 1,
      capabilities: ['validator'],
      id: 'mismatched-capability',
      provides: { services: [sourceProviderService.id] },
      version: '1.0.0',
    },
    setup() {},
  });
  assert.throws(() => new WorkflowPluginRuntime({
    plugins: [{
      configuration: configuration('mismatched-capability'),
      plugin: mismatchedCapability,
    }],
  }), /必须声明 source-provider capability/);

  const circular = (id: string, dependency: string): WorkflowPlugin => definePlugin({
    manifest: {
      apiVersion: 1,
      capabilities: ['validator'],
      id,
      requires: { plugins: [dependency] },
      version: '1.0.0',
    },
    setup() {},
  });
  assert.throws(() => new WorkflowPluginRuntime({
    plugins: [
      { configuration: configuration('cycle-one'), plugin: circular('cycle-one', 'cycle-two') },
      { configuration: configuration('cycle-two'), plugin: circular('cycle-two', 'cycle-one') },
    ],
  }), /依赖存在循环/);
};

const nodeLoaderContract = async (): Promise<void> => {
  const config = structuredClone(loadWorkflowConfig());
  config.plugins = [{
    id: 'fixture-source',
    module: './dist/tests/fixtures/plugins/source-plugin.js',
    permissions: [],
  }];
  const host = await createNodePluginHost(config, { workspaceRoot });
  await host.start();
  const [provider] = host.getServices(sourceProviderService);
  assert.ok(provider);
  assert.equal((await provider.capture({ entry: 'direct' })).sourceType, 'fixture');
  await host.stop();

  await assert.rejects(
    loadNodePlugins([{ id: 'outside', module: '../outside.js' }], workspaceRoot),
    /不能越出工作区/,
  );
};

const configurationAndRpcContract = (): void => {
  const config = structuredClone(loadWorkflowConfig());
  config.plugins = [
    { id: 'duplicate', module: '@fixture/one' },
    { id: 'duplicate', module: '@fixture/two' },
  ];
  assert.ok(validateWorkflowConfig(config).some((message) => message.includes('不能重复')));

  const request = createPluginRpcRequest('request-1', 'plugin.describe', { verbose: true });
  assert.equal(request.protocolVersion, 1);
  assertPluginRpcResponse({
    id: request.id,
    jsonrpc: '2.0',
    protocolVersion: 1,
    result: { id: 'remote-plugin' },
  }, request);
  assert.throws(() => assertPluginRpcResponse({
    id: 'wrong-id',
    jsonrpc: '2.0',
    protocolVersion: 1,
    result: null,
  }, request), /响应 id 不匹配/);
};

/** Covers plugin ordering, permissions, rollback, loading and transport contracts. */
export const main = async (): Promise<number> => {
  try {
    await lifecycleContract();
    await permissionContract();
    await rollbackContract();
    await declarationContract();
    await nodeLoaderContract();
    configurationAndRpcContract();
    process.stdout.write(
      '插件契约回归通过：依赖、权限、生命周期、回滚、ESM 加载与 RPC 边界正常。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`插件契约回归失败：${errorMessage(error)}\n`);
    return 1;
  }
};

const isDirectRun = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
