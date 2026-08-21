# Tool Adapter Contract

工具适配器的职责是把当前 Agent 的能力映射到 `agent-workflow/`，而不是复制或改写核心流程。

## 运行时加载

每个适配器都必须引导执行者按 `START.md` 生成 Route Packet：

1. 所有任务只启动 `AGENTS.md` 及 `agent-workflow setup` 写入的实际 `START.md` / `ROUTER.md` 包路径。
2. 使用 `workflow:route` 选择 Route/Stage/Entry，优先 `--materialize` 合并当前阶段卡
   和命中 Skill；超限时按 Packet 白名单读取。
3. 复用 Packet 输出的匿名 Run ID；Micro Change 重复提交结构化 Gate 事实，并从 Review 起
   提交任务专属 unified diff 做实际范围门禁。
4. 阶段切换时重新生成 Packet，不累计阶段手册。
5. 完整 `README.md`、Source Capture、项目策略、Adapter 和 Reference 只在当前卡明确要求时读取。
6. Portable 任务先使用 `portable-resume`，读取状态摘要后切换实际路由。

如果工具不能自动发现仓库规则，应使用 `agent-workflow setup` 安装薄入口；仍不支持时，运行 `agent-workflow setup --agent generic` 输出与安装位置一致的启动提示。

工作流维护、工具配置和纯 Git 操作使用独立 Route，不加载业务 Source，也不伪造 Source Snapshot。

## 允许包含

- 工具的规则入口和启动方式。
- 文件读取、编辑、命令、MCP、subagent、hooks、异步执行能力的映射。
- 不支持某项能力时的降级方式。
- 工具特有的安全提示和已知限制。

## 禁止包含

- 新的项目业务规则或产品规范。
- 与核心阶段不同的另一套工作流。
- 覆盖用户授权、Git 边界或项目禁止事项的规则。
- 只有当前工具能够理解的任务状态。
- 把工具记忆、聊天历史或内部 TODO 当成唯一交接依据。

## 能力声明

开始执行前只判断当前会话真实可用的能力，不根据产品名称假设：

| 能力 | 可用时 | 不可用时 |
|------|--------|----------|
| Repository Read | 按需读取最小上下文 | 请求用户提供文件或片段 |
| File Edit | 执行最小修改 | 输出 patch 或逐文件修改说明 |
| Command | 执行项目允许的命令 | 列出人工执行命令和预期结果 |
| Skill / Rule | 读取被选中的 SKILL.md；Reference 按触发条件加载 | 读取 Packet 指定的本地 Markdown |
| MCP / Connector | 读取外部事实 | 执行项目定义的受控降级；无降级时请求必要输入 |
| Subagent | 分离定位、实现、Review | 当前执行者串行完成并区分阶段 |
| Hooks | 自动触发门禁检查 | 按阶段清单手工执行 |
| Background / Cloud | 运行 Async Mode | 使用 Pair Mode 或输出可交接 patch |

Pool Entry 的 MCP 降级只有在 Source Lite 不足时才读取 `source-capture.md`。Direct Entry 使用用户原文，不得擅自调用 MCP 做核对或补全。

Route 调用日志只能保存匿名化结构字段；Adapter 不得附加用户原文、业务正文、文件
内容、命令参数、Cookie、Token 或其他凭据。反馈分析只读取聚合结果。

项目 Skill 的唯一事实源是 `.agents/skills/`。工具原生 Skill 目录如需兼容，只能保存指向该目录的薄桥接，不得复制完整 `SKILL.md` 或 references。

所有具备文件写入能力的工具在标准流程生成正式业务 Spec 后，都必须执行 `agent-workflow/docs/03-spec.md` 的自动落盘协议。Micro Change 不生成正式 Spec。工具不能写文件时，应输出完整的目标路径和可直接保存的文件内容，并明确标记“未落盘”。

## 适配器模板

```md
# <Tool> Adapter

遵守 [`README.md`](./README.md) 定义的适配器契约。

## Bootstrap
- 技术入口：`agent-workflow setup` 生成的实际包路径
- 项目策略：
- 业务入口：
- Portable 任务状态：

## Capability Mapping
- Repository Read：
- File Edit：
- Command：
- Skill / Rule：
- MCP / Connector：
- Subagent：
- Hooks：
- Background / Cloud：

## Fallback
- 按当前工具能力填写降级路径。

## Tool-specific Safety
- 按当前工具权限模型填写安全边界。
```

## Review 要求

新增或修改适配器时检查：

- 删除适配器后，核心流程是否仍能由 `generic-agent.md` 执行。
- 是否只引用事实源，没有复制长规则。
- 是否为不可用能力提供降级路径。
- 是否能读取 Portable 任务，并优先处理 `Current Stage` 的 `in_progress` / `blocked` 阶段，否则从第一个 `pending` 阶段继续。
- 是否正确区分 Pool Entry 和 Direct Entry；只有 Pool Entry 无法取得详情时才停在 `blocked-at-entry`。
- 是否正确区分 Micro Change Brief 与正式业务 Spec，并只为后者保存最小追踪包。
- 是否没有放宽项目规则和用户授权。
