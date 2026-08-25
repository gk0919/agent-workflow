# Migrations

配置或任务产物发生破坏性 Schema 变更时，在此提供可重复、可回滚或明确不可逆边界的迁移器。目录重排不通过运行时兼容分支长期维持旧路径。

项目专属词汇、Issue 格式、Provider 和 Skill 兼容信息留在对应项目的 Profile 或迁移记录中，
不进入通用 `PORTABILITY.md`、Core、Schema 或 Validator。

## MCP Source Provider 模块路径

`mcp-source-provider` 已从示例目录迁移为正式模块。宿主配置需要将：

```text
@gk0919/agent-workflow/examples/mcp-source-provider
```

替换为：

```text
@gk0919/agent-workflow/plugins/mcp-source-provider
```

Plugin `id`、权限和 `options` 契约保持不变。旧示例路径不保留兼容导出，避免宿主继续依赖 `examples/`。真实 endpoint、Token 环境变量、Route 和编号规则仍由宿主配置，不迁入正式模块。

## Execution Workspace State v1

Phase 4 新增 `./schemas/execution-workspace-state.json`，用于宿主本机的 Run/Node/Lane worktree
binding。它是新增 Runtime 格式，不替换 Phase 0-3 的 Workflow Definition、Execution Event、
Artifact 或任务级 worktree state，因此旧 Workflow 和旧 Run 不需要数据迁移。

写入字段以向后兼容方式加入 Workflow Definition v1；旧串行/只读入口继续拒绝 `effect`、
`integrator`、repository binding 和 `maxExternalWrites > 0`。宿主只有在显式改用
`runWritableWorkflow`、提供 `ExecutionWorkspaceService` 并重新通过 Definition 校验后，才会创建
新状态。该状态包含 host-local 绝对路径，不得复制到其他宿主；需要迁移机器时应保留 Portable
Journal/Artifact，重新创建 Run，而不是改写 state 中的路径。
