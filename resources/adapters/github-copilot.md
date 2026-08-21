# GitHub Copilot Adapter

适用于 GitHub Copilot Chat、agent mode、cloud agent 和 code review。

遵守 [`Tool Adapter Contract`](./README.md)。Repository instructions 只负责引导加载事实源。

## Repository Instructions

GitHub Copilot 的 repository instructions 只指向 setup 写入的实际 `START.md` 包路径；启动后用 Router 选择当前阶段卡，不自动加载完整项目策略。

不要把所有长规则都复制到 repository instructions；长文档应通过链接、MCP 或明确引用按需读取。

## Agent Mode

适合本地交互式任务：

- 先研究和计划。
- 再实现。
- 最后请求 code review 或按 `agent-workflow/docs/06-review.md` 自审。

## Cloud Agent

适合异步 issue：

- 输入必须有清晰问题、期望行为和验收标准。
- 只有任务明确授权创建 PR 时，输出才可以是 draft PR；否则输出 patch 或完整报告。
- PR 描述必须包含 Intake、Spec 摘要、Verify Report 和未验证项。
- 人工 review 通过前不得合并。

## Code Review

使用 Copilot review 时，仍然按 `agent-workflow/docs/06-review.md` 解释和处置 findings。AI review 不是最终批准。
