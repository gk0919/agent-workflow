# Pi Adapter

适用于 Pi 编码代理（@earendil-works/pi-coding-agent）的交互模式。遵守 [`Tool Adapter Contract`](./README.md)，本文件只定义启动和能力映射。

## Bootstrap

Pi 通过工作目录及父目录的 context file 自动加载根目录 `AGENTS.md`，由它进入 setup 写入的实际 `START.md` 包路径和 Router。后续只加载 Route Packet 的当前阶段卡与命中 Skill；Portable 任务先读取状态摘要，再切换实际 Packet。

如需项目级补充，写入 `.pi/APPEND_SYSTEM.md`，只保留指向 `START.md` 和本适配器的短规则，不得复制项目事实源。

## Capability Mapping

- Repository Read：`read` 工具，按阶段执行最小必要读取。
- File Edit：`edit` / `write` 工具，执行最小修改，不处理无关内容。
- Command：`bash` 工具，只运行项目策略允许的命令，服从其中的构建与测试限制。
- Skill / Rule：自动发现 `.agents/skills/*/SKILL.md`，按 description 选择；Reference 按触发条件加载。
- MCP / Connector：项目 MCP 在 `.pi/mcp.json` 配置，按 `agent-workflow/docs/09-runtime.md` 使用；未配置时执行项目策略降级。
- Extensions：可注册自定义工具，但不得用扩展覆盖用户授权或 Git 边界。
- Subagent：无；由当前执行者串行完成定位、实现、Review，并区分阶段。
- Hooks：无；按阶段清单手工执行门禁检查。
- Background / Cloud：无；需要异步时输出可交接 patch 与 Verify 清单。

## Portable Handoff

- 接手业务任务时先用 `task-portable-resume` 读取 manifest/source/handoff 当前摘要，再只读核对 Git 状态。
- Pi 的 Todo、会话历史和内部记忆不能替代 Portable 任务产物。

## Fallback

- 无法读取文件时，请求用户粘贴必要文件。
- Pool Entry 无法调用 MCP 时，按 `source-capture.md` 使用只读 CLI；无法执行 CLI 时要求用户提供该命令的完整 JSON 输出。Direct Entry 不调用 MCP 或 CLI。
- 无法修改仓库时，输出 patch、目标路径和 Verify 清单。

## Tool-specific Safety

- 当前会话的 `.pi/permissions.json` 权限配置优先于一般能力说明。
- Pi 无 plan mode 与 subagent，不得据此放宽项目规则或用户授权；串行执行不改阶段产物。
- 不把会话记忆或 Todo 沉淀为未经审查的业务规则。
