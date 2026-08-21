# Qoder Adapter

适用于 Qoder IDE、Qoder Plugin 或 Qoder CLI。遵守 [`Tool Adapter Contract`](./README.md)，本文件只定义启动和能力映射。

## Bootstrap

Qoder 支持读取根目录 `AGENTS.md`，由它进入 setup 写入的实际 `START.md` 包路径和 Router。后续只加载 Route Packet 的当前阶段卡与命中 Skill；Portable 任务先读取状态摘要，再切换实际 Packet。

如果项目配置了 `.qoder/rules`，其中只保留简短启动规则并指向 `START.md`。Qoder Rules 的优先级不得用来覆盖项目事实源。

## Capability Mapping

- Rules：使用 `AGENTS.md` 或 `.qoder/rules` 启动，长规则按路径读取。
- Repository Read / Edit：按阶段执行最小必要读取和修改。
- Command：只运行项目策略允许的命令，并服从其中登记的构建与测试限制。
- MCP：已配置时按 `agent-workflow/docs/09-runtime.md` 使用，未配置时执行项目策略中的降级路径。
- Agent / Quest：可用于 Plan、Implement、Review 等阶段，但输出必须回写到标准阶段产物。
- Background：只有输入明确、影响可控、验证方式清楚时使用 Async Mode。

## Portable Handoff

- 接手业务任务时先用 `portable-resume` 读取 manifest/source/handoff 当前摘要，再只读核对 Git 状态。
- Qoder 的 Memory、Snapshots、会话历史和内部任务卡不能替代 Portable 任务产物。
- 离开 Qoder 前更新 `Resume`、`handoff.md`、Review 和 Verify 状态。

## Fallback

- 无法调用 Rule 时，直接按 UTF-8 读取对应 Markdown。
- Pool Entry 无法调用 MCP 时，按 `source-capture.md` 使用只读 CLI；无法执行 CLI 时要求用户提供该命令的完整 JSON 输出。Direct Entry 不调用 MCP 或 CLI。
- 无法使用后台或多执行者能力时，按 Pair Mode 串行执行。
- 无法修改仓库时，输出 patch 和 Verify 清单。

## Tool-specific Safety

- 当前会话的权限配置优先于一般能力说明。
- 不使用自动记忆沉淀未经审查的业务规则。
- 不把 snapshot/rollback 能力当成 Git 提交或用户授权。
