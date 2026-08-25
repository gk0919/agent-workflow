# 多 Agent 执行内核架构路线图

| 属性 | 值 |
|---|---|
| 状态 | Phase 0、Phase 1、Phase 2、Phase 3、Phase 4 已实现；Phase 5 仍为 Proposed |
| 最近评审 | 2026-08-25 |
| 适用范围 | `agent-workflow` 通用包与宿主适配器 |
| 兼容策略 | 可选、渐进、串行可降级，不改变现有 Route 与任务产物语义 |

本文记录多 Agent 执行内核的目标架构、不可破坏的不变量和分阶段落地条件，供后续架构升级或修改时评审使用。本文不是启动提示，不加入 Base Docs 或默认 Route Packet；只有维护执行内核、公共契约或宿主适配器时才按需读取。

相关现有契约：[`ARCHITECTURE.md`](./ARCHITECTURE.md)、[`PORTABILITY.md`](./PORTABILITY.md)、[`PLUGINS.md`](./PLUGINS.md)、[`security-boundaries.md`](./security-boundaries.md)、[`verification-contract.md`](./verification-contract.md)。若本文与已经发布的 CLI、Schema 或上述当前契约冲突，以已发布契约为准，并先通过版本化变更修订冲突。

## 决策摘要

`agent-workflow` 可以在现有控制面下增加可选执行面，但不直接复制任何单一宿主的脚本运行时。

目标方案是：

1. 保留 Route、Profile、Task、Approval、Verification 和 Security Policy 作为控制面。
2. 新增可移植、声明式的 Workflow IR 作为执行计划事实源。
3. 新增可选 Execution Kernel，负责调度、并发、检查点、恢复、取消和预算。
4. 通过公共 Agent Executor 契约接入不同宿主或模型，不在 Core 中绑定具体产品。
5. 所有不可信 Workflow、输入、Agent 输出和持久化事件先做结构校验，再做语义与安全校验。
6. Phase 1 基线只支持串行、只读和可恢复执行；Phase 2 已开放有界只读并行；Phase 4 只通过显式 effect、Approval 和隔离 Worktree 开放写入并行，脚本外观仍按后续阶段开放。

不采用的目标方案是：直接在主 Node 进程中加载或执行模型生成的任意 JavaScript。若未来提供 TypeScript/JavaScript 作者体验，它只能生成声明式 IR，不能成为受信任执行边界。

## 架构不变量

后续实现和评审不得破坏以下规则：

- **控制面与执行面分离**：Route 决定业务阶段和 Gate，Execution Graph 只编排阶段内部工作。
- **公共事实源可移植**：Workflow 定义、运行事件和结果契约使用版本化 JSON 数据，不依赖 `src/` 私有模块。
- **判断在 Agent，机械规则在代码**：检索、综合和审查可以交给 Agent；计数、依赖、预算、去重键、状态转换和权限交集由确定性代码执行。
- **权限只收窄不扩大**：节点有效权限是 Core 上限、Profile、Workflow、Executor 和宿主授权的交集。
- **预算必须有硬上限**：Agent 数、并发数、尝试次数、循环次数、持续时间和外部写入不能只作为提示。
- **恢复不能重复副作用**：所有可恢复 effect 必须有稳定幂等键；外部写入默认不自动重试。
- **结构通过不等于语义通过**：JSON Schema 只负责形状；领域关系、路径、Git、授权和安全规则继续由 Validator/Core 负责。
- **并行写入必须隔离**：只读节点可以共享工作区；写节点必须拥有明确文件范围或独立 Worktree。
- **降级不改变产物语义**：不支持多 Agent 的宿主可以串行执行同一 IR，但不得跳过节点、Gate 或验证。
- **规划能力不得冒充现状**：本文所列组件在通过对应阶段退出标准前均为 Proposed。

## 当前基础与缺口

现有系统已经具备多 Agent 内核的控制面基础。Phase 0 已增加公共执行契约与静态编译器，
Phase 1 已增加确定性串行 Runner、File Journal、内容寻址 Artifact 和 Fake Executor；
Phase 2 已增加稳定批次的只读并行调度、动态 map lane、失败隔离和确定性归约；
Phase 3 已增加原生宿主 Adapter、独立进程 Executor、能力协商和串行降级；
Phase 4 已增加写入 effect、Run/Node/Lane Worktree binding、Integrator 和副作用恢复协议。

| 现有能力 | 可复用职责 | 仍需新增 |
|---|---|---|
| Route / Profile | 选择路径、阶段和策略 | 阶段内部 Execution Graph |
| Route Packet | 构造受预算控制的上下文 | 节点级 Context Snapshot 与引用 |
| Task Lifecycle | `pending`、`blocked`、`resume`、`complete`；Execution Run 已有 Run、Node、Attempt 事件 | Task Stage 与 Execution Run 的自动绑定 |
| Plugin Runtime | 服务注册、依赖、权限和回滚；已注册 Agent Executor 标准服务 ID | Executor 实现与 capability negotiation |
| Validator Service | 领域校验扩展点；已实现 Workflow/Event Ajv 结构校验和 DAG 语义校验 | 运行输入、节点输出和持久化状态校验 |
| Approval Provider | 人工决策入口 | Run/Node Checkpoint 绑定与重放保护 |
| Artifact Store | 保存内容与元数据；Phase 1 File Store 使用 SHA-256 内容寻址 JSON | 可替换 Artifact Store 与跨宿主引用 |
| Reporter | 外部报告扩展点 | 标准执行事件和使用量事件 |
| Worktree | 任务与仓库隔离 | Run/Node/Lane 级资源租约 |
| Verification Contract | 目标、改动和验证追踪 | 节点结果到验证证据的绑定 |
| Runtime Feedback | 匿名化聚合；Execution Journal 已独立保存在 ignored runtime | Journal retention、导出与远程实现 |

现有 `AgentAdapterService` 只负责指令适配，不承担模型调用。执行能力必须使用新的独立契约，避免一个服务同时负责提示转换、调度和副作用。

## 控制面与执行面的边界

Route Task Flow 表达业务生命周期：

```text
Inspect -> Implement -> Review -> Verify -> Git Inspect
```

Execution Graph 表达某个阶段内部的运行拓扑：

```text
Review
  -> discover targets
  -> review each target
  -> join findings
  -> deduplicate
  -> adversarial verify
  -> ranked report
```

二者关系是“Execution Run 必须归属于一个任务阶段”，而不是把 Route Stage 改造成 Agent Node。一个阶段可以没有 Execution Run，也可以按显式计划产生多个 Run；需要组合时优先由一个 Root Workflow 记录子工作流关系。Task Manifest 继续记录可审计的业务阶段；Execution Journal 记录节点尝试和运行恢复。执行工作流完成后，只能通过现有 Task Gate 推进业务阶段。

## 目标分层

```text
Route / Profile / Approval / Security Policy
                    |
                    v
          Workflow Definition / IR
                    |
                    v
     Compiler + Static Policy Validation
                    |
                    v
       Execution Kernel / Scheduler
         |          |          |
         v          v          v
  Agent Executor  Artifact   Reporter
         |          Store       |
         v          |           v
  Host / Remote  Journal    Observation
```

### 1. Workflow Definition / IR

Workflow Definition 是版本化 JSON 公共契约。首版最小字段建议包含：

- `schemaVersion`
- `id`、`description`
- 输入 Schema 或输入契约引用
- 节点列表和稳定节点 ID
- 节点依赖
- 输出 Schema 或输出契约引用
- 权限与工具能力要求
- Workspace 模式
- Agent、并发、尝试、循环、时间和写入预算
- 失败、重试、取消和降级策略

首版只引入最小节点集合：

| 节点 | 语义 |
|---|---|
| `agent` | 执行一次 Agent 请求并校验结果 |
| `map` | 对已验证数组逐项展开相同子任务 |
| `parallel` | 调度固定的独立分支 |
| `join` | 等待依赖完成并组合结果引用 |
| `reduce` | 使用确定性规则或专用 Agent 汇总 |
| `gate` | 以确定性条件允许、阻断或暂停 |
| `checkpoint` | 持久化并允许人工批准后继续 |
| `subworkflow` | 调用已注册 Workflow，首版最多一层 |

循环必须使用带 `maxIterations` 的受限节点，不能开放无界 `while`。节点间数据通过受限 JSON Pointer/结果引用传递，不能执行任意表达式。

### 2. Compiler 与静态检查

执行前必须完成：

- Schema 与版本兼容性检查
- 节点 ID 唯一性
- 依赖存在性和 DAG 环检测
- 输入/输出引用闭包检查
- 循环、并发和 Agent 总量上界检查
- Executor capability negotiation
- 权限交集和工具要求检查
- Workspace/Worktree 可行性检查
- 外部写入与人工 Gate 检查
- Workflow、Profile 和输入内容 hash 计算

静态检查失败时不得启动任何 Agent。

### 3. Execution Kernel

Kernel 只负责确定性机制：

- 就绪节点选择
- 有界并发和资源锁
- Agent 调用与取消
- 结构化结果校验
- 失败分类和重试判定
- Checkpoint、暂停和恢复
- Artifact 与 Journal 持久化
- 运行结束状态归约

Kernel 自身不直接读取仓库、执行 Shell 或访问网络。这些能力只能由获得授权的 Agent Executor 或 Tool Provider 执行。

### 4. Agent Executor

计划新增独立公共服务，概念契约如下：

```ts
interface AgentExecutorService {
  describe(): Promise<AgentExecutorCapabilities>;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  cancel?(request: AgentCancellationRequest): Promise<void>;
}
```

`AgentExecutionRequest` 至少绑定：

- `runId`、`nodeId`、`attempt`
- prompt 与 Context Artifact 引用
- output Schema
- 模型与 reasoning policy
- 工具和权限 allowlist
- Workspace/Worktree binding
- token、持续时间和工具调用预算
- 幂等键

`AgentExecutionResult` 至少返回：

- `succeeded`、`failed`、`cancelled` 或 `blocked`
- 经过 JSON 可序列化检查的输出
- Artifact 引用与 hash
- 使用量和实际 Executor/模型信息
- Validation Finding
- 标准错误分类和是否可安全重试

进程或远程实现必须使用版本化传输契约；`AbortSignal` 等进程内对象不能进入可移植 RPC 数据模型。

### 5. 持久化与恢复

Execution Journal 使用 append-only 事件，不复用匿名化 Runtime Feedback。建议事件至少包含：

```text
run.created
run.started
node.scheduled
node.started
node.output-validated
node.completed
node.failed
node.retry-scheduled
run.checkpointed
run.paused
run.resumed
run.cancelled
run.completed
```

每条事件绑定：

- Workflow Definition hash
- Profile/Route 版本
- 输入和权限快照 hash
- Run、Node、Attempt ID
- Artifact ID/hash
- 状态、时间、使用量和错误分类

恢复规则：

1. 定义、输入、权限或必要能力变化时，不得静默复用旧 Run。
2. 已完成且 Artifact 完整的纯只读节点可以复用。
3. 未完成节点重新执行。
4. 仓库写入节点恢复前必须检查 Worktree 和后置条件。
5. 外部写入节点默认进入人工 Checkpoint，不自动重试。
6. 每个 effect 使用 `{runId, nodeId, attempt}` 派生幂等键。

可恢复状态保存在 `.agent-workflow/runtime/`，默认不纳入版本控制；需要 Portable 交接时只导出脱敏、版本化的摘要和 Artifact 引用，不导出凭据、完整提示或宿主私有会话状态。

## Schema 与校验策略

执行内核会显著增加运行时 JSON 信任边界，因此保持 JSON Schema 为公共事实源，并以
Draft 2020-12 Validator 承担结构层。Phase 0 已将 Ajv 2020 与 `ajv-formats` 声明为直接
运行时依赖，使用 strict、无 coercion、无 defaults、无字段移除的配置，并把错误适配为
稳定的公共文本。后续阶段仍需持续检查依赖体积、启动时间和 Schema 一致性。

需要校验的对象包括：

- Workflow Definition 与 Input
- Executor Capability
- Agent Output
- Execution Event 与 Checkpoint
- Run State 与 Artifact Metadata

Validator 配置必须：

- strict 模式
- 不修改输入，不启用 coercion、defaults 或移除字段
- 不加载远程 `$ref`
- 只解析注册表中的 Schema
- 限制 Schema、输入、输出的字节、深度和集合大小
- 缓存编译结果
- 不使用可执行任意代码的自定义 keyword
- 把底层错误转换为稳定的公共 Validation Finding

Schema 通过后仍必须执行：

- 节点引用、DAG 与状态语义检查
- 权限和批准绑定
- 路径、Symlink、Git ref 与 Worktree 检查
- 敏感数据与外部写入检查
- Verification Contract 追踪检查

## 并发、Worktree 与副作用

默认资源模型：

- 只读节点可以共享同一 Workspace Snapshot。
- 写节点必须声明文件 ownership 或获得独立 Worktree。
- 不知道写入范围时禁止共享工作树并发。
- 同一资源锁内的写节点串行执行。
- 每个并行 lane 使用 Run/Node/Lane 级 Worktree binding。
- 合并由单独的 Integrator 节点顺序执行。
- 全局构建和测试在合并后统一运行，不由每个 lane 重复执行。

第一版 Worktree 扩展不能改变现有任务级 binding 语义；新字段或新 Schema 版本必须提供明确迁移和旧格式兼容行为。

## 权限、预算与安全

有效权限按以下顺序求交集：

```text
Core hard limit
  AND Profile policy
  AND Workflow declaration
  AND Plugin grant
  AND Host/session authorization
```

子 Agent、Tool Output、网页、附件和上游节点结果均是不可信数据，只能提供事实，不能控制：

- Workflow 拓扑
- 权限和 allowlist
- Approval 状态
- 重试与预算上限
- Route 与 Task 状态
- 数据外传目标

首版建议保守默认值，最终数值由版本化 Security Policy 统一定义：

- 串行执行或极低并发
- 小规模 Agent 总数
- 每节点有限尝试次数
- 所有循环有限轮次
- 默认禁止外部写入
- 达到连续失败或重试上限后停止并报告

预算提示不能替代 Runtime 硬限制。Executor 无法报告 token 时，结果必须明确记录 `unknown`；Kernel 仍通过 Agent 数、并发、时间和工具调用数提供确定性上界。

## 可移植宿主模型

同一 Workflow IR 支持三种执行方式：

1. **Native Adapter**：把宿主原生单 Agent 调用映射为标准 Executor；拓扑仍由 Kernel 调度。
2. **Local Runner**：由 Node Host 通过 Agent Executor Plugin 调度。
3. **Serial Fallback**：宿主不支持并行时按依赖顺序串行执行。

每个 Executor 必须先返回 capability，例如：

- structured output
- cancellation
- usage reporting
- model routing
- tool allowlist
- workspace isolation
- parallel execution
- persistent resume

Workflow 可以声明 required 与 preferred capability。缺少 required capability 时必须拒绝执行；缺少 preferred capability 时可以明确降级并记录事件。

至少两个独立宿主通过同一套契约和 conformance fixtures 后，才能把相应能力标记为 Portable。

## 公共 API 与包边界

执行内核继续遵守包级公开边界：

- 项目和 CI 只依赖 CLI、Schema 与数据契约，不引用 `src/`。
- Workflow、Run、Event、Executor 和 Artifact 的可移植类型从正式 package export 导出。
- JSON Schema 随包发布并拥有稳定 subpath export。
- Node Runner、宿主 Adapter 和具体 Executor 使用独立 subpath；不要求只消费契约的调用方加载执行实现。
- 供应商 SDK、模型客户端和原生宿主集成优先作为可选 peer 或独立 Plugin，不进入通用契约。
- Core 若采用 Ajv 等运行时实现，必须声明直接依赖并记录包体积、启动时间和升级策略；不得依赖传递安装。
- 持久化格式或 RPC envelope 变化按 Schema 版本迁移，不能只依赖 TypeScript 类型变化。

Workflow Definition 的包内、项目级和个人级存储位置在 Phase 0 决定；在位置、覆盖优先级和 Symlink 边界形成版本化契约前，不新增隐式扫描目录。

## 可观测性与隐私

Reporter 应能观察：

- Run 和 Node 状态
- phase/节点拓扑
- Agent 数、并发、耗时和使用量
- 重试、取消和阻断原因
- Validation Finding
- 已验证与未验证结果数量

默认日志不得记录：

- 用户完整原文
- 完整系统提示
- 凭据、Token 和 Secret
- 未脱敏工具输出
- 宿主账号、设备和个人身份

可恢复 Artifact 与匿名化反馈日志必须分开保存、分别执行 retention policy。

## 分阶段路线图

### Phase 0：架构与契约（已完成）

交付：

- 架构决策与术语
- Workflow Definition Schema
- Execution Event Schema
- Executor Capability/Request/Result 契约
- 错误、预算、权限、重试和幂等规则
- Fake Executor 与 conformance fixture 设计

退出标准：不调用真实模型，也能验证 Workflow、拒绝非法图并生成稳定的静态执行计划。

当前实现（2026-08-25）：

- `./execution` 公共导出提供 Workflow、Execution Event、Agent Executor 和静态计划契约。
- `./schemas/workflow-definition.json` 与 `./schemas/execution-event.json` 提供版本化
  Draft 2020-12 Schema。
- `agent-workflow execution:plan --file <path>` 对工作区内显式文件执行结构和语义校验，
  拒绝重复/缺失/自依赖、环、死节点、非终端结果、超预算和非本地 `$ref`，并生成按节点
  ID 稳定排序的 DAG layers 与 SHA-256 Workflow hash。
- Phase 0 只声明 `agent`、`join`、`gate`、`checkpoint`；不执行模型、不写 Journal、
  不调度并发，也不创建 Worktree lane。
- `execution:test` 与策略门禁覆盖确定性、非法图、事件约束、公共 CLI 和包导出。

上述退出标准已满足；Fake Executor 的可执行 conformance fixture 随 Phase 1 Runner 落地。

### Phase 1：确定性串行 Runner（已完成）

交付：

- `agent`、`join`、`gate`、`checkpoint`
- Fake Executor
- 结构化输出校验
- append-only Journal
- pause、resume、cancel
- 硬预算和错误分类

退出标准：进程退出后可从 Journal 恢复，已完成只读节点不重复执行，Workflow 变化不会复用旧结果。

当前实现（2026-08-25）：

- `runSerialWorkflow` 按静态计划逐节点执行 `agent`、`join`、`gate` 和
  `checkpoint`，Phase 1 强制 `maxExternalWrites: 0`、共享只读 Workspace 和只读权限。
- `FileExecutionJournalStore` 将事件保存为 sequence-only 不可变文件并使用
  `previousEventHash`/ `eventHash` 形成 SHA-256 hash 链；节点输出保存为内容寻址 JSON
  Artifact。Journal 和 Artifact 位于 `.agent-workflow/runtime/executions/`，不进入版本控制。
- Run 创建时绑定 Workflow hash、Input hash 和 Input Artifact。Resume 会重放事件，只复用
  Artifact 完整的 `node.completed`；定义或输入变化会在调用 Executor 前被拒绝。
- Agent Result 先经过可移植 JSON、身份、使用量和节点 output Schema 校验；无效输出可以在
  `maxAttemptsPerNode` 内重试，超时、工具调用、尝试次数和总持续时间由代码执行硬限制。
- Fake Executor 使用显式、版本化 Fixture 按 `nodeId + laneId + attempt` 返回结果，不解析 prompt；
  conformance regression 覆盖重试、恶意返回、恢复和终态不重复调用。
- `execution:run`、`execution:resume`、`execution:pause`、`execution:cancel` 提供
  Phase 1 CLI；Checkpoint approval 通过 resume 的 `--approve <node-id>` 显式提供。
- Pause/Cancel 是 Journal 级协作控制，不承诺跨进程强制中断正在运行的第三方 Executor；
  真实宿主取消由后续 Executor Adapter 负责。

上述退出标准已满足；Phase 1 入口继续显式拒绝 `map`、`parallel`、`reduce`，避免旧入口静默改变语义。

### Phase 2：只读并行（已完成）

交付：

- `map`、`parallel`、`reduce`
- 有界并发和超时
- 部分失败隔离
- 汇总、去重和对抗验证模式
- Agent/Node 使用量统计

退出标准：相同输入和 Fake Executor 下调度结果可复现；并发不突破硬上限；取消后状态可恢复。

当前实现（2026-08-25）：

- `runParallelWorkflow` 按静态 DAG layer 选择就绪节点，将 Agent 和 Map lane 放入稳定排序的
  wave；有效并发为 Workflow `maxConcurrency` 与 Executor `maxConcurrency` 的较小值。
  调用可以真实并发完成，但结果、重试和 Journal 事件始终按稳定 task/lane 顺序提交。
- `map` 只接受一个已完成依赖，通过受限 JSON Pointer 读取数组，并以 `maxItems` 建立静态
  Agent 上界；lane ID 由数组索引稳定生成，item 作为内容寻址 Artifact 传递。恢复时只复用
  已有且 Artifact 完整的 lane，未确认完成的在途 lane 使用下一 attempt。
- `parallel` 汇总固定依赖分支；失败节点只有显式声明 `failurePolicy: isolate` 才允许继续，
  `minSuccess` 决定整体阈值。`adversarial` 模式静态要求至少两个 Agent/Map 分支成功，但
  Phase 2 不声称验证模型、提示或宿主之间的真实独立性。
- `reduce` 使用受限 JSON Pointer 选择输入，并提供 `collect` 与基于 canonical JSON 的
  精确 `dedupe`；不执行任意表达式、脚本或模型生成代码。
- Agent/Node/Run 使用量从 Journal 中重放聚合，包含调用数、失败数、持续时间、token、
  tool call 和观察到的最大并发；Executor 报告 unknown 时汇总保持 `null`。
- 在途 wave 会轮询 Journal 的 pause/cancel 状态并触发 Executor best-effort cancellation；
  已持久化取消保持终态可重放，暂停恢复不会复用未完成 attempt。
- `execution:parallel:run`、`execution:parallel:resume` 和 `--scheduler parallel` 提供
  显式 CLI；Fixture 支持 `laneId` 和确定性 `delayMs` 并发测试。
- conformance regression 覆盖完成顺序反转时事件序列一致、并发上限、Map lane 部分失败、
  deterministic dedupe、对抗汇总、进程中断恢复、超时取消、运行中外部取消、使用量和 CLI。

上述退出标准已满足；Phase 3 在不改变 Phase 2 调度和 Journal 语义的前提下接入宿主 Executor。

首个真实试点应选择只读、结果可独立验证的工作流，例如：

```text
discover changed files
  -> per-file review
  -> deterministic dedupe
  -> independent verifier
  -> ranked report
```

### Phase 3：宿主执行器与可移植性（已完成）

交付：

- 一个原生宿主 Adapter
- 一个独立的第二 Executor
- Generic Serial Fallback
- capability negotiation
- 跨 Executor conformance tests

退出标准：同一 Workflow Definition 在至少两个宿主中保持节点、Gate、输出 Schema 和最终状态语义一致。

当前实现（2026-08-25）：

- `NativeHostAgentExecutor` 将进程内宿主的 capability、单节点 invoke 和可选 cancel 映射为
  标准 `AgentExecutorService`。Adapter 补齐标准结果身份和 unknown usage，不接管拓扑、重试、
  Gate、Schema 校验或 Journal。
- `ProcessAgentExecutor` 通过版本化的单请求 stdin/stdout JSON 协议接入独立进程；每次调用使用
  新进程、`shell: false`、显式 command/arguments、响应时间与 stdout/stderr 字节上限。
  Workflow 不能选择进程命令，异常退出、损坏 JSON、协议版本和 request ID 不匹配均被拒绝。
- `./schemas/agent-executor-process.json` 与 `./execution` 的 process protocol types 是正式包契约；
  实现可用于 Node 以外语言，只需保持 JSON envelope 和 Executor Result 语义。
- `negotiateExecutorCapabilities` 统一计算 required capability 错误、preferred capability 降级、
  requested/effective concurrency 以及 `parallel`、`serial`、`serial-fallback` 模式。
- `runPortableWorkflow` 默认允许 Generic Serial Fallback。Executor 只支持并发 1 时仍运行同一
  IR 的全部节点、Gate、输出 Schema 和 Journal；`serialFallback: 'reject'` 可在首个事件前拒绝。
- `executor-portability-regression` 用进程内原生宿主和独立 Node 子进程运行同一包含 Agent、Map、
  Reduce、Gate 与输出 Schema 的 Definition，并比较节点摘要、内容寻址 Artifact、语义事件与终态；
  同时覆盖无效结构化输出、降级拒绝、无效 JSON 和响应身份不匹配。

上述退出标准已满足。具体宿主接入与 conformance 要求见
[`EXECUTOR-PORTABILITY.md`](./EXECUTOR-PORTABILITY.md)。Phase 3 的 `runPortableWorkflow` 入口仍只允许
共享只读 Workspace，不得借 Adapter 绕过权限交集或外部写入 Approval；可写执行必须显式使用
Phase 4 的 `runWritableWorkflow` 和 `ExecutionWorkspaceService`。

### Phase 4：写入 Agent 与 Worktree（已完成）

交付：

- Run/Node/Lane Worktree binding
- 文件 ownership 和资源锁
- Integrator/Merge 节点
- 冲突检测与合并后验证
- 写入节点幂等与恢复规则
- 外部写入 Approval Checkpoint

退出标准：并行 lane 不共享可写工作树；冲突不会静默覆盖；恢复不会重复已确认的外部副作用。

当前实现（2026-08-25）：

- Workflow Definition 新增版本 1 的 `effect` 和 `integrator` 向后兼容字段。静态编译器验证 Approval
  祖先、repository、`exclusive-worktree`、`workspace:write`、精确 ownership、Integrator 依赖和
  写入调用上界；旧 Definition 不需要迁移，旧 Runner 继续显式拒绝写入语义。
- `runWritableWorkflow` 使用现有 DAG、Journal、Artifact、预算、Checkpoint 和 capability negotiation；
  写节点必须获得 tool allowlist，repository 写入还必须获得 workspace isolation 能力。
- `GitWorktreeWorkspaceService` 将 Run/Node/Lane 绑定到共同 base commit 上的独立 detached
  worktree。Executor 的 host-local root 不进入 Portable Event/Artifact；runtime state 使用独立的
  `./schemas/execution-workspace-state.json` 版本 1 Schema。
- repository effect 在执行前写入 stable `effect-prepared`，成功输出经过 ownership、ignored file、
  `git diff --check` 后形成本地 commit，再写 `effect-confirmed`。崩溃后只恢复可唯一证明的 commit；
  状态不明确时暂停，不重复执行。
- external effect 在 prepared/confirmed 之间崩溃时一律暂停人工核对；confirmed 后崩溃只补写节点
  completed，不再次调用 Executor。
- 调度器按物化后的 resource lock 生成无冲突 wave；Map 的 `{lane}` 同时作用于 ownership 和锁，
  不同 lane 使用不同 binding/root。
- Integrator 在独立 worktree 中先拒绝 changed-path ownership 碰撞，再按稳定 binding 顺序执行
  `cherry-pick --no-commit`。Git 冲突返回 `merge-conflict`，不会写主工作树或静默选边。
- 合并结果必须经过 `git diff --cached --check` 和宿主只读 Verifier。Verifier error、异常或修改
  workspace 都阻止 integration commit，并返回 `verification-failed`。
- `execution:writable:test` 在临时真实 Git 仓库覆盖隔离、并发锁、ownership 越界、冲突、验证失败、
  repository commit 恢复，以及 external effect 的 confirmed/unconfirmed 崩溃窗口。

上述退出标准已满足。公共接入、Definition 约束、恢复矩阵和宿主安全边界见
[`WRITABLE-EXECUTION.md`](./WRITABLE-EXECUTION.md)。

### Phase 5：动态作者体验

交付：

- 模型生成声明式 Workflow Definition
- 静态图、预算和权限预览
- 用户批准后执行
- 可选 Builder，仅生成 IR
- Workflow 保存、版本和迁移工具

退出标准：模型输出始终先经过 Schema 与策略校验；未经批准的拓扑、权限或预算变化不能运行。

## 明确暂缓

以下能力在前置阶段完成前不得进入 Core：

- 任意 JavaScript Workflow 执行
- 无界循环或递归 Workflow
- 默认大规模 Agent fan-out
- 多个 Agent 共享真实工作树写入
- 未声明幂等策略的自动重试
- 无 Approval 的外部写入
- 绑定单一模型供应商的 Core 类型或字段
- 将宿主私有会话缓存作为 Portable 恢复事实源
- 以多个同源 Agent 的一致意见替代独立证据

## 架构变更检查表

后续修改本路线图或实现执行内核时，评审至少回答：

1. 这是控制面规则还是执行面机制？责任层是否唯一？
2. 是否新增或改变公共 CLI、Schema、事件或持久化格式？
3. 旧 Workflow、旧 Run 和不支持多 Agent 的宿主如何兼容或降级？
4. 是否扩大了模型、工具、文件系统、网络或外部写入权限？
5. 失败、取消、恢复和重试是否会重复副作用？
6. Agent、并发、循环、时间和使用量是否有硬上限？
7. 是否能用 Fake Executor 和确定性 fixture 回归？
8. 是否至少有一个独立 Validator 或 Verifier，不由产出节点自证？
9. 新状态属于版本控制、Portable Artifact 还是本机 Runtime？
10. 是否增加启动链上下文；若增加，能否改为按 Route/Stage 延迟加载？

任何影响公共契约或持久化语义的实现都必须先更新本文、对应 Schema、迁移说明和契约测试，再开放 CLI 行为。
