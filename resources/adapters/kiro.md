# Kiro Adapter

适用于 Kiro 的 spec-driven workflow。

遵守 [`Tool Adapter Contract`](./README.md)。Kiro Specs 是阶段产物的一种呈现，不改变核心门禁。

## 文件映射

| Kiro | `agent-workflow` |
|------|----------------|
| `requirements.md` | `01-intake.md` + `02-prd.md` |
| `design.md` | `03-spec.md` |
| `tasks.md` | `04-plan.md` |
| steering | `docs/00-principles.md` + Active Profile policy + domain rules |

## Requirements

PRD 中的验收标准建议写成 EARS：

```text
WHEN [condition/event]
THE SYSTEM SHALL [expected behavior]
```

## Steering

按加载频率拆分：

- always：项目硬约束。
- auto：场景规则，例如表格、弹窗、权限。
- fileMatch：特定技术栈或目录规则。
- manual：重流程、长文档、低频知识。

## 执行

Kiro 执行 tasks 时，每个任务都应能追踪到 requirement 和 verify 项。

Portable 业务任务必须保留 `source.md`，并把 Kiro 侧阶段状态同步到 `manifest.md` 和 `handoff.md`，不能只保存在 Kiro 内部状态中。
