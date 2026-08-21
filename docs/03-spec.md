# Spec

Spec 把 PRD 转成可执行技术方案，并建立
[`verification-contract.md`](./verification-contract.md) 定义的目标与验证契约。

## 输入

Source Snapshot、Intake、按需 PRD、项目地图和相关代码。

## 输出模板

```md
# Technical Spec

## 涉及模块
模块、页面、菜单和业务域。

## 仓库上下文
目标仓库、模块和预期改动；跨仓库分开说明。

## 涉及文件
- `path/to/file`

## 当前实现
现有逻辑、状态和数据流。

## 目标实现
本次要改变的行为。

## Goal & Verification Contract
引用 `verification.json` 的状态、关键 ID 和设计取舍，不复制全文。

## 数据流
输入、处理、输出和持久化。

## 接口变更
新增、修改、复用或无变更。

## 前端改动
页面、状态、校验和反馈。

## 后端改动
接口、权限、日志和兼容。

## UI 规范点
只记录命中的专项规范。

## 风险点
兼容、权限、性能和跨模块影响。

## 需求追踪
引用 G / AC / C / VT；只补充结构化契约无法表达的依据。

## 回滚方案
如何撤销配置、代码或数据影响。
```

## 通过标准

- 可追踪到 Entry、Source Type 和目标仓库；Pool Entry 还包括 SN/ID。
- 已定位主要文件并说明现状与目标差异。
- 每个 AC 至少映射一个 Planned Change 和一个 Verification Test Point。
- 风险、兼容和验证矩阵不为空；MCP 分别记录能力、授权和环境。
- 没有把产品问题留到实现阶段；高风险方案已确认。

## 自动落盘

正式 Spec 按 [`12-artifacts.md`](./12-artifacts.md) 保存最小包及 `verification.json`。
Micro Change 不触发落盘；升级进入 Spec 后开始遵守。只保存实际生成的可用产物。

`spec.md` 顶部使用：

```yaml
---
task_id:
entry_mode: pool | direct
source_type: demand | defect
source_sn:
spec_level: S | M | L
contract_version: 1
status: draft | conditional | confirmed
created_at:
updated_at:
---
```

状态为 `draft`、`conditional` 或 `confirmed`；只有 `confirmed` 可以完成 Spec Gate。
继续澄清时更新同一文件。

契约由 Spec / Plan 建立、Implement 按 patch 更新、Verify 收口。历史兼容和启用时间以
`verification-contract.md` 为准。每次保存同步更新 manifest 阶段与 Next Action。

自动落盘只授权创建和更新任务产物，不授权 stage、commit、push 或创建 PR。

## 设计深度

根据风险选择 Spec 深度：

| 等级 | 场景 | 需要内容 |
|------|------|----------|
| S | 单文件小修、文案、低风险样式 | G/AC、涉及文件、C、VT |
| M | 页面行为、表单校验、接口字段 | 当前实现、目标实现、风险、完整验证矩阵 |
| L | 跨模块、公共组件、数据结构 | 数据流、接口、回滚、兼容、追踪矩阵 |
