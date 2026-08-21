# Workflow Retention Policy

机器可读配置见 [`retention-policy.json`](../resources/policies/retention-policy.json)。

## 分层

- Runtime 日志：本地临时状态，已加入 `.gitignore`；超过配置期限后成为清理候选。
- 未完成任务：超过 `staleOpenTaskDays` 只告警，不自动改变状态。
- Conversation 完成任务：超过期限后成为归档候选。
- Portable 完成任务：保留时间更长，归档前确认已无需交接。
- Knowledge `_staging`：超过期限且未晋升时成为人工复核候选。
- 已批准知识、已提交审计产物和业务事实源不由本策略自动删除。

## 安全边界

当前模式固定为 `report-only`。`workflow:retention` 只列出候选，不删除、移动、归档或
修改任务。任何实际清理都需要用户明确指定目标；清理前再次检查任务状态、Git 状态和
业务保留要求。

报告不输出业务正文，只包含候选类型、工作区相对路径和年龄。
