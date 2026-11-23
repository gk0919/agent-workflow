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
