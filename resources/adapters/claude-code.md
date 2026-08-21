# Claude Code Adapter

适用于 Claude Code 或具备 subagent/hooks 的环境。

遵守 [`Tool Adapter Contract`](./README.md)。`CLAUDE.md` 只作为启动入口，不复制项目事实源。

## 执行方式

- `CLAUDE.md` 只导入 `AGENTS.md` 并指向 setup 解析出的实际 `START.md` 包路径，后续文件由启动协议按需加载。
- Portable 业务任务先用 `portable-resume` 读取 manifest/source/handoff 当前摘要，内部 Todo 或会话记忆不能替代它们。
- 大任务先生成 Plan，并随执行更新状态。
- 支持 subagent 时，可拆分以下角色：
  - locator: 定位文件和影响范围
  - implementer: 执行最小代码改动
  - reviewer: 独立代码审查
  - verifier: 执行测试和验证记录

## Hooks

如果可配置 hooks，建议：

- Post-edit: 调用 `agent-workflow quality:js --hook-input`，再按中立 Skill 路由做语义审查。
- Pre-commit: 调用 `agent-workflow quality:all`。
- Pre-push: 检查分支、远端和 CI 状态。

`.claude/skills` 不保存项目 Skill 副本；Claude 先按 `.agents/skills/*/SKILL.md`
的 `description` 选择 Skill，场景仍不清时才读取深度项目策略。

## 降级

没有 subagent 或 hooks 时，按 `agent-workflow/` 串行执行，不改变阶段产物。
