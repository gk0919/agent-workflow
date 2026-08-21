# Cline / Roo Code Adapter

适用于 Cline、Roo Code 以及类似 Plan/Act、多模式 agent 工具。

遵守 [`Tool Adapter Contract`](./README.md)。模式只是核心阶段的映射，不是另一套流程。

## 模式映射

| 模式 | 对应阶段 |
|------|----------|
| Plan | Intake、PRD、Spec、Plan |
| Act | Implement、Review、Verify、Git |
| Ask / Architect | 澄清、方案、风险分析 |
| Debug | 缺陷复现、定位、验证 |

## 执行规则

- Plan 模式不得直接改代码。
- Act 模式开始前必须有目标文件和完成标准。
- Review 最好使用独立模式或独立上下文。
- 高风险命令、删除、批量替换、push 必须确认。
- Portable 业务任务必须保留 `source.md`，阶段状态必须写入 `manifest.md` 和 `handoff.md`，不能只保存在模式或会话中。

## 自定义模式

可配置以下模式：

- `workflow-intake`
- `workflow-spec`
- `workflow-implement`
- `workflow-review`
- `workflow-verify`

每个模式都只读取对应 `agent-workflow/` 文件，避免上下文过载。
