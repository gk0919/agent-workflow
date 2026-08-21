# Cursor Adapter

适用于 Cursor Agent、Background Agent 或普通 Cursor Chat。

遵守 [`Tool Adapter Contract`](./README.md)。Cursor Rules 只负责启动和按场景加载，不复制项目事实源。

## 执行方式

- `.cursor/rules/ai-workflow.mdc` 只负责自动指向 setup 解析出的实际 `START.md` 包路径。
- Portable 业务任务先用 `portable-resume` 读取 manifest/source/handoff 当前摘要；Cursor 的内部计划不是跨工具状态。
- 大任务先生成 Plan，再进入实现。
- 使用 Rules 管理稳定约束，避免把长文档全部 always apply。
- 修改后按 `agent-workflow/docs/06-review.md` 和 `agent-workflow/docs/07-verify.md` 输出结果。

## Background Agent

适合处理：

- 独立缺陷
- 文档更新
- 测试补充
- 小范围重构

不适合在需求不清或 UI 截图依赖较强时直接异步实现。

## 降级

Cursor 无法直接访问某些上下文时，要求用户补充文件或截图说明。
