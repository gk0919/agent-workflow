# Executor 可移植接入

Phase 3 提供两个正式的 `AgentExecutorService` 接入边界。Workflow 拓扑、调度、重试、
Gate、结构化输出校验和 Journal 始终由执行内核负责；Adapter 只执行单个 Agent/Map lane。

## 原生宿主 Adapter

宿主实现 `NativeAgentHost` 的三个最小成员：稳定 `id`、`getCapabilities()` 和
`invoke(request)`；需要协作取消时再实现 `cancel(request)`。随后通过公开
`@gk0919/agent-workflow/execution` 导出的 `NativeHostAgentExecutor` 适配。

Adapter 会补齐 API 版本、Run/Node/Lane/Attempt 身份、Executor 身份和 unknown usage，
宿主不需要复制调度或 Journal 逻辑。宿主结果仍会由内核验证可移植 JSON、身份、预算和
节点 `outputSchema`。

## 独立进程 Executor

`ProcessAgentExecutor` 为每次 `describe` 或 `execute` 启动一个新进程，通过 stdin 写入一个
JSON request，并从 stdout 读取一个 JSON response。协议版本为
`AGENT_EXECUTOR_PROCESS_PROTOCOL_VERSION = 1`，公开 Schema 为
`./schemas/agent-executor-process.json`。

进程命令和参数只能由可信宿主显式配置，不能来自 Workflow Definition。实现固定使用
`shell: false`，限制 describe 时间、stdout 和 stderr 字节数，拒绝非零退出、无效 JSON、
协议版本或 request ID 不匹配，并在内核取消节点时终止对应子进程。凭据由宿主进程启动环境
管理，不得写入 Workflow、Event、Artifact 或 Executor 响应。

## 能力协商与降级

`negotiateExecutorCapabilities(definition, capabilities)` 返回稳定的：

- required capability 不兼容项；
- preferred capability 降级项；
- requested/effective concurrency；
- `parallel`、`serial` 或 `serial-fallback` 模式。

`runPortableWorkflow` 默认允许 `serial-fallback`：当 Workflow 请求并行而 Executor 的
`maxConcurrency` 为 1 时，仍执行相同节点、Gate 和 Schema 校验，只改变调度并发度。对吞吐
或独立性有硬要求的调用方可传入 `serialFallback: 'reject'`，在写入首个 Run Event 前拒绝。

## Conformance 要求

新的 Executor 至少应以同一 Workflow Definition 对照一个既有 Executor，验证：

1. required capability 缺失时在调用前拒绝；
2. Agent 和 Map lane 的请求身份、权限与预算不被扩大；
3. 合法与非法结构化输出得到相同终态分类；
4. Gate、节点摘要、结果 Artifact 与最终状态语义一致；
5. 串行降级不跳过节点、验证或 Journal 持久化；
6. 超时、取消和损坏的传输响应不会被当作成功结果。

仓库策略门禁中的 `executor-portability-regression` 使用一个进程内原生宿主和一个独立 Node
子进程执行相同 IR，覆盖上述跨宿主语义与协议拒绝路径。
