# Intake

Intake 的目标是把原始需求或缺陷整理成结构化事实，避免执行者在信息不足时直接改代码。

业务任务进入 Intake 前必须通过 [`source-capture.md`](./source-capture.md) 的 Entry Gate。Pool Entry 使用需求池/缺陷池详情；Direct Entry 使用用户首次粘贴的自包含原文。

## 输入

- Source Snapshot
- 用户描述
- 需求编号或缺陷编号
- 截图、附件、日志
- 复现步骤
- 期望结果
- 相关页面、菜单、模块

## 输出模板

```md
# Intake Card

## 类型
需求 / 缺陷 / 调研 / 重构 / 评审 / 文档 / Git

## 来源
Entry Mode、Source Type、Capture Method、Captured At 和 Source Snapshot；Pool Entry 还要记录 SN/ID。

## 原始描述
保留关键原文，不改写事实。

## 背景
业务背景、触发原因、涉及角色。

## 当前现象 / 用户诉求
描述现在发生了什么，或用户希望得到什么。

## 影响范围
涉及页面、模块、接口、数据、权限、旧数据。

## 仓库上下文
仓库根目录、业务子仓库、当前分支；尚未定位时标记为“待定位”。

## 复现步骤
1. 
2. 
3. 

## 期望结果
用户可观察到的目标行为。

## 附件 / 截图
列出文件、链接或说明无法查看的内容。

## 验收标准
- 
- 

## 待澄清问题
- 
```

## Lite 配置

`Intake (lite)` 仍属于 Intake 阶段，不是独立阶段。它适用于信息完整、范围收敛的简单任务，至少保留：

- 类型与来源。
- 目标行为或要回答的问题。
- In Scope / Out of Scope。
- 可判断的验收标准或分析完成条件。
- 仓库上下文。
- 待澄清问题；没有时写“无”。

未提供且与当前任务无关的小节可以省略，但不得省略业务任务的 Source Snapshot 引用。

## 通过标准

- 业务任务已经通过 Source Capture Entry Gate。
- 已引用 Source Snapshot；Pool Entry 已记录需求/缺陷编号和完整详情。
- 已区分事实、推断和待确认问题。
- 已明确是否可以进入 PRD/Spec。
- 已记录已知的仓库或业务模块上下文。
- UI、截图、业务语义存在歧义时，不直接实现。
- 缺陷修复必须明确当前现象和期望结果。

业务任务生成 Spec 时，本阶段产物随最小 Spec 包保存为 `.agent-workflow/tasks/local/<task-id>/intake.md`。
