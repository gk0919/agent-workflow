# Agent Workflow 仓库约束

- 处理本仓库任务前先读取并遵守 `docs/START.md`，工作流维护使用 `workflow-maintenance` Route。
- 通用 Core、资源、Schema 和 Validator 不得包含具体业务项目名称、Skill 名、Issue 前缀或仓库路径。
- 项目和 CI 只能依赖 `agent-workflow` CLI、Schema 与数据契约；`src/` 不是公开 API。
- 修改 JavaScript 后运行目标增量检查；完成修改后运行 `npm run quality:policy`。
- 不得提交 `.agent-workflow/runtime/`、本地任务数据、`dist/`、凭据或 npm Token。
- stage、commit、push、创建 Release 和发布 npm 包是独立授权动作。

