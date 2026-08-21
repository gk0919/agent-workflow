# Generic Agent Adapter

适用于没有专用工具能力的通用模型或聊天工具。

遵守 [`Tool Adapter Contract`](./README.md)。它是所有专用 adapter 的最低降级基线。

## 执行方式

- 先读取 `AGENTS.md` 及其中声明的实际 `START.md` / `ROUTER.md` 包路径；不能运行路由脚本时人工生成同格式 Packet，只读取当前阶段卡。
- Pool Entry 必须从本地需求池/缺陷池详情开始，没有 Skill 时按 Source Capture 的 MCP/CLI 路由降级；Direct Entry 直接保留用户原文。
- Portable 业务任务先读取当前状态摘要，并要求用户提供无法自行核对的仓库状态。
- Router 选择最小充分路由；标准流程也一次只加载当前阶段卡，不在启动时读取 README 或全部阶段文件。
- 如果不能读取文件，要求用户粘贴必要文件。
- 如果不能修改文件，输出 patch 或逐文件修改说明。
- 标准流程生成正式业务 Spec 但不能写文件时，输出 `.agent-workflow/tasks/local/<task-id>/spec.md` 等目标路径和完整内容，并明确说明尚未落盘；Micro Change 不生成这些文件。
- 如果不能执行命令，列出需要人工执行的命令。
- 如果不能调用 Skill，读取项目策略登记的 `SKILL.md`；不能读取文件时请求用户提供正文。
- Pool Entry 不能调用 MCP 时，必须先确认完整工具注册表不存在对应工具，再使用 Source Capture 定义的只读 CLI；不能执行 CLI 时要求用户提供该命令的完整 JSON 输出。Direct Entry 不执行这一步。
- 用户已明确要求 commit、但当前工具不能创建时，输出 commit message 和提交前检查清单。

## 降级输出

当无法直接操作仓库时，至少输出：

```md
## 需要用户提供

## 建议修改文件

## Patch / 修改说明

## Review Checklist

## Verify Commands

## Handoff / Next Action

## Commit Message
```

## 禁止事项

- 不声称已经执行实际未执行的命令。
- 不声称已经查看实际未查看的文件。
- 不把推断伪装成仓库事实。
