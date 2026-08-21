# Instructions as Code

AI 规则文件应像代码一样治理。它们会直接影响 Agent 行为，因此必须结构化、可审查、可版本化。

## 文件类型

| 类型 | 示例 | 何时加载 | 是否为事实源 |
|------|------|----------|--------------|
| Workflow Core | START、Router、当前阶段卡 | 薄入口始终加载；阶段卡按需 | 是 |
| Project Policy | 项目硬约束、事实源索引 | 场景归属不清或 Packet 指定时 | 是 |
| Active Profile | 任务词汇、Provider、Review Skill、Issue 与治理路径 | 配置和 Route Packet 解析时 | 是 |
| Root Constraints | 高频跨任务约束 | 每次任务 | 是 |
| Skill | 特定场景的流程、工具和专业知识 | 按 description 命中 | 是 |
| Reference | 完整规范、示例和检查清单 | Skill 明确要求时 | 是 |
| Tool Rule | 薄启动或文件/场景路由 | 工具自动加载 | 否 |
| Quality Gate | 确定性静态检查 | 写后、提交前或 CI | 是 |
| Source Record | Pool 详情快照或 Direct 用户原文 | 业务任务进入 Intake 前加载 | 是，限当前任务和捕获时间 |
| Domain | 表格、弹窗、权限、策略 | 命中场景时加载 | 是 |
| Adapter | Codex、Qoder、TRAE、Claude | 对应工具加载 | 否，只做能力映射 |
| Task State | manifest、source、spec、review、verify | 已有 Spec 包或 Portable 任务加载 | 是，限当前任务 |
| Knowledge | 历史踩坑、模块经验 | 检索命中后加载 | 候选事实，需核验 |

同一条长期规则只保留一个事实源。其他入口使用链接或导入，不复制正文；因工具限制必须复制时，应标记来源并建立同步检查。

运行上下文由 `agent-workflow/resources/routes.json` 编译：启动文档、当前阶段卡和 Skill 必须受字符预算约束；深度 Reference 不得出现在 eager docs。

运行反馈也按代码治理：只记录匿名化结构字段，聚合结果默认不超过工具输出上限，
原始事件不进入 Agent 上下文。重复问题先进入 knowledge `_staging`，必须经人工
证据、验证、敏感信息和复用边界门禁后才能晋升。用户明确确认当前唯一候选无误时，
Agent 可通过确定性的 `workflow:knowledge -- approve` 同步记录人工结论并晋升；晋升不等于自动加载。

## 推荐元数据

新规则文件建议在顶部补充：

```yaml
---
id: workflow-review
description: Code review checklist for AI-assisted changes.
aliases:
  - review
  - code-review
tags:
  - workflow
  - quality
load: manual
---
```

`load` 可选值：

- `always`：核心规则，始终加载。
- `auto`：根据 description 命中加载。
- `fileMatch`：根据文件路径加载。
- `manual`：用户或 Agent 显式引用时加载。

## 编写要求

- 一个文件只解决一类问题。
- 写清适用场景和不适用场景。
- 给出正例和反例。
- 避免空泛表达，例如“写高质量代码”。
- 避免互相冲突的规则。
- 规则变更需要 review。
- 不在 adapter 中新增业务规则、产品规范或授权。
- 不在根约束或 `always_on` Rule 中复制完整领域规范。
- 能确定判断的问题优先写入共享 Node.js 检查器；需要语义判断的问题保留给 Skill 和 Review。
- 不把聊天记忆、工具内部计划或未落盘 TODO 当成跨工具状态。
- 不在启动入口中递归要求读取 README、完整阶段手册、项目策略或 Reference。
- 阶段切换时重新生成 Route Packet，不把上一阶段流程细节长期保留在工作上下文。
- 强制规则如果以 Skill 发布，必须同时保留可被普通文件读取能力访问的 `SKILL.md` 或规范正文。

## Adapter 约束

所有工具适配器遵守 [`adapters/README.md`](../resources/adapters/README.md)：

- 入口只指向 Workflow Core、Project Policy 和 Portable Task State。
- 工具能力必须在当前会话中探测，不能仅根据产品名称假设。
- hooks、subagent、MCP、后台执行均为可选增强。
- 工具缺少某项能力时，使用文件、patch、人工命令或串行阶段降级。
- 切换工具时，以 Git 状态和任务产物为准，不以旧工具的对话摘要为准。

## 质量检查

规则文件 review 时检查：

- 是否足够短，能被 Agent 稳定遵守。
- 是否有明确触发条件。
- 是否包含禁止事项。
- 是否与项目现有规则冲突。
- 是否会导致上下文过载。
- 是否需要拆分成更小文件。
- 是否能由 `generic-agent.md` 在没有专用能力时执行。
- 是否把工具专属状态错误地当成事实源。
- `workflow:context` 是否通过，代表性 Route Packet 是否低于预算。
- 路由日志是否只包含允许字段，反馈摘要是否受限，经验候选是否禁止自动晋升。

## 冲突处理

优先级从高到低：

1. 安全、权限、合规和组织级约束。
2. 用户当前明确指令。
3. 项目规则。
4. 当前工作流阶段规则。
5. 工具适配规则。
6. 个人偏好和历史经验。
