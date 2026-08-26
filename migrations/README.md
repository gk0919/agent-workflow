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

## Workflow Definition Bundle v1

Phase 5 新增 `./schemas/workflow-definition-bundle.json`，作为模型、Builder 或人工作者 Definition 的
版本化保存信封。它不会替换 Workflow Definition v1，旧 Definition、Run、Event 和 Artifact 不需要
迁移，Phase 0–4 Runner 继续直接接受 Definition v1。

需要版本保存时运行：

```text
agent-workflow execution:author:migrate \
  --file <legacy-definition.json> --output <bundle-v1.json> [--version <n>]
```

迁移只把已通过 Schema/语义校验的裸 Definition v1 包装为 Bundle v1，并记录 `source=migration`、
Definition Hash 和版本。当前 Bundle v1 输入只做严格校验后原样规范化；未知未来版本不会被猜测迁移。
保存和迁移命令拒绝覆盖已有输出文件，版本链需要显式提供前一版本号和 Definition Hash。
