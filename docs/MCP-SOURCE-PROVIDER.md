# MCP Source Provider

内置 `mcp-source-provider` 模块把精确来源编号适配到公开的 `SourceProviderService` 契约。它使用官方 MCP TypeScript 客户端，通过 Streamable HTTP 延迟连接，并从可配置的凭据来源读取 Bearer Token，随 Plugin 生命周期关闭 MCP 会话。模块不包含任何业务平台名称、编号前缀或固定工具名。

模块不包含凭据，也不内置任何项目地址、编号格式或工具名称。严禁把 Bearer Token 写入 `.agent-workflow/config.json`、源文件、终端历史或 Git。

## 1. 安装可选传输依赖

Workflow Core 不强制宿主安装 MCP SDK。启用此模块的宿主项目需要显式安装可选 Peer Dependency：

```sh
pnpm add -D @gk0919/agent-workflow @modelcontextprotocol/client@^2.0.0
```

## 2. 配置 Plugin

把 [`config.example.json`](../resources/plugins/mcp-source-provider/config.example.json) 中的 `plugins` 项合并到宿主项目的 `.agent-workflow/config.json`，保留项目现有的 Profile 和路径设置。然后在 Active Profile 中把逻辑 Provider Entry 绑定到 Plugin `id`：

```json
{
  "sourceProviders": {
    "pool": {
      "kind": "connector",
      "name": "mcp-source-provider"
    }
  }
}
```

随包配置只使用中立 HTTPS 占位地址、`PROJECT_MCP_TOKEN` 和通用编号格式。真实 endpoint、Token 环境变量、Route、工具名和编号规则必须由宿主配置。仅当服务明确只支持受信内部网络的 HTTP endpoint 时，才设置 `allowInsecureHttp: true`；服务支持后应优先迁移到 HTTPS。

配置示例中的 Route 如下：

| Route | MCP 工具 | 编号格式 |
|---|---|---|
| `requirement` | `query_requirement` | `REQ-...` |
| `defect` | `query_bug` | `BUG-...` |

命令把 Profile 中的逻辑 Entry `pool` 传给 Provider。当该 Entry 不是 Adapter 的直接 Route 时，Provider 会根据 `referencePattern` 选择唯一匹配的已配置 Route；零匹配或多匹配都会失败关闭。

首次捕获时，Provider 调用 `tools/list`，并从每个工具的 `inputSchema` 推断编号参数。如果 Schema 中有多个可能参数，应在对应 Route 中配置真实参数名：

```json
{
  "tool": "query_requirement",
  "referenceArgument": "actual_parameter_name",
  "referencePattern": "^REQ-"
}
```

不要猜测参数名；应从 MCP 工具 Schema 或错误提示列出的候选参数中确认。

## 3. 配置凭据来源

默认兼容旧配置的 `tokenEnv` 环境变量。使用包内凭据助手时，Provider 可通过明确的 `credential-store` 类型直接读取用户配置目录中的 `credentials.json`，不依赖 `bin` 命令入口：

```json
{
  "auth": {
    "type": "credential-store",
    "profile": "project-default"
  }
}
```

`command` 类型仍表示执行外部命令并读取其标准输出；它不会被解释为包内凭据存储。

如需使用其他凭据助手，可配置命令或仓库外的绝对路径凭据文件：

```json
{
  "auth": {
    "type": "command",
    "command": "mcp-credential-helper",
    "args": ["token", "--profile", "project-default"]
  }
}
```

命令通过无 shell 的 `execFile` 启动，标准输出可以是裸 Token，也可以是 `{\"access_token\":\"...\"}`；标准错误不会回传到工作流错误。凭据助手应自行使用 Windows Credential Manager、Linux Secret Service 或权限为 `0600` 的用户文件。

包内提供通用的 `mcp-credential-helper` CLI。运行 `mcp-credential-helper set project-default` 设置凭据，交互式输入以 `*` 提供掩码反馈，管道调用则从 stdin 读取。使用 `status` 检查状态，使用 `clear` 清除凭据；Token 不作为命令行参数传递。当前实现使用用户配置目录和 `0600` 文件权限，Windows 与 WSL 会分别保存各自凭据。

文件方式要求绝对路径，文件内容同样支持裸 Token 或 `access_token` JSON：

```json
{
  "auth": {
    "type": "file",
    "path": "C:/Users/user/.config/mcp/token"
  }
}
```

`auth` 与旧的 `tokenEnv` 不能同时配置。配置中禁止写入 Token 值。

## 4. 在运行时提供轮换后的 Token（兼容旧配置）

PowerShell，仅对当前进程生效：

```powershell
$env:PROJECT_MCP_TOKEN = '<rotated-token>'
```

兼容 Bash 的终端：

```sh
export PROJECT_MCP_TOKEN='<rotated-token>'
```

建议直接提供原始 Token；带 `Bearer ` 前缀的值也会被接受并规范化。Provider 不会输出 Token，只在请求前即时向 SDK 提供凭据。

## 5. 校验与捕获

由于 Provider 延迟连接，`plugins:check` 只校验配置和生命周期，不会建立网络连接：

```sh
pnpm exec agent-workflow plugins:check
```

捕获一个精确来源并输出有界 JSON 事实：

```sh
pnpm exec agent-workflow source:capture --entry pool --reference REQ-123456
pnpm exec agent-workflow source:capture --entry pool --reference BUG-123456
```

Provider 通常由 Active Profile 的 `sourceProviders.pool` 绑定选择。`--provider mcp-source-provider` 只用于显式诊断覆盖；`--format json` 用于输出紧凑的机器可读结果。

MCP 工具错误、缺少 Route、编号格式异常、Schema 歧义、超时或凭据缺失都会失败关闭，并返回非零退出码。

结果只保留 MCP 文本块和结构化内容；图片与二进制块会被排除。嵌套层级、集合大小和文本长度都会在进入工作流事实前受到限制。
