# 插件系统

插件系统用于扩展可执行能力，但扩展不得替代工作流状态流转、审批门禁、安全决策、契约版本管理或产物账本完整性。

正式内置 Plugin 位于 `src/plugins/`，只通过 `package.json#exports` 声明的公共子路径供宿主使用。`examples/` 只展示宿主接入结果，不得作为模块导出或被宿主直接依赖。

## 运行层级

- 声明式扩展仍放在 Profile、Route、阶段卡、Schema 和策略中。
- 受信任的 TypeScript/JavaScript 扩展使用进程内 ESM 宿主。
- Python、Rust、C# 和不受信任的 Node 扩展使用带版本的 JSON-RPC 边界。
- 外部系统使用 MCP、HTTP 或 gRPC Adapter。通用包只定义边界，不强制所有宿主安装同一种传输 SDK。

进程内权限是可审计的宿主服务契约，不是安全沙箱。需要隔离的插件不得通过 `host-node` 加载。
进程边界使用 JSON-RPC 2.0、独立协议版本，以及固定的 `plugin.describe`、`plugin.activate`、
`plugin.deactivate` 和 `service.invoke` 方法集合。

## 受信任的 ESM 插件

```ts
import {
  definePlugin,
  sourceProviderService,
  type SourceProviderService,
} from '@gk0919/agent-workflow/plugin-sdk';

const provider: SourceProviderService = {
  id: 'example-source',
  async capture(request) {
    return {
      capturedAt: new Date().toISOString(),
      facts: { entry: request.entry },
      sourceId: request.reference ?? request.entry,
      sourceType: 'example',
    };
  },
};

export default definePlugin({
  manifest: {
    apiVersion: 1,
    capabilities: ['source-provider'],
    id: 'example-source',
    provides: { services: [sourceProviderService.id] },
    version: '1.0.0',
  },
  setup(context) {
    context.provide(sourceProviderService, provider);
  },
});
```

在 `.agent-workflow/config.json` 中配置：

```json
{
  "plugins": [
    {
      "id": "example-source",
      "module": "@example/agent-workflow-source",
      "permissions": [],
      "options": {}
    }
  ]
}
```

运行 `agent-workflow plugins:check` 会加载全部启用插件，校验插件清单与权限，按依赖顺序激活，并验证逆序清理。启动失败时，本次激活产生的全部副作用都会回滚。

普通 CLI 命令在执行前后激活和关闭宿主，只发送 `command:before` 与 `command:after` 元数据；命令参数和用户内容不会进入事件。程序调用方通过 `createNodePluginHost()` 获取能力服务。

通用包还提供正式内置的 MCP `source-provider` 模块和通用捕获命令。安全的环境变量认证、Active Profile 的 Source Provider 绑定、Route 映射和 `agent-workflow source:capture` 精确来源捕获方式，见
[`MCP-SOURCE-PROVIDER.md`](./MCP-SOURCE-PROVIDER.md)。

## 契约规则

- 配置中的 `id` 必须与插件清单中的 `id` 一致。
- `apiVersion`、能力、权限、提供的服务和依赖必须在执行 `setup` 前完成校验。
- 插件只能获取 `requires.services` 声明的服务，只能注册 `provides.services` 声明的服务。
- Route Extension 只能返回候选项，不能直接决定 Route；Approval Provider 只能收集决定，最终决策和状态变更仍由受保护的 Core 执行。
- 带权限的宿主服务必须同时具备插件清单申请和项目显式授权。
- 事件串行执行；服务注册、订阅和 `context.effect` 清理按后进先出顺序撤销。
- 插件或服务依赖存在循环时，必须在执行任何 `setup` 前失败。
