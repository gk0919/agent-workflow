# Plan

Plan 的目标是把 Spec 拆成可执行步骤，并在执行中持续更新状态。

Plan 复用 Spec 的 Goal & Verification Contract，不重新编号或复制另一份验收标准。

## 输出模板

```md
# Task Plan

## Phase 1: 需求理解
- [ ] 阅读 Intake / PRD / Spec
- [ ] 标记待确认问题

## Phase 2: 代码定位
- [ ] 阅读项目地图
- [ ] 定位页面、模块、接口和公共组件
- [ ] 确认影响范围

## Phase 3: 方案确认
- [ ] 区分直接原因与设计根因，或明确需求不变量和规则责任层
- [ ] 确认消除根因的最小完整语义闭环，不以文件数或代码行数衡量
- [ ] 用同类/后续扩展场景和异常边界检查复用性、扩展性与健壮性
- [ ] 对比表象补丁与推荐方案，记录未采用原因
- [ ] 确认风险和回滚方式
- [ ] 确认每个 AC 已映射 Planned Change 和 Test Point
- [ ] 探测 MCP / Playwright 等当前会话能力，但不预先声称环境可用

## Phase 4: 实现
- [ ] 修改目标文件
- [ ] 避免无关改动

## Phase 5: 自审
- [ ] 逻辑检查
- [ ] 规范检查
- [ ] 内存泄漏检查

## Phase 6: 验证
- [ ] 执行项目允许的静态检查
- [ ] 仅在项目规则允许且用户已授权时运行 lint/test
- [ ] 按 VT 记录 MCP / CI / 人工验证
- [ ] 记录 capability、证据、阻塞和未验证项

## Phase 7: Git
- [ ] 确认每个目标仓库的根目录、分支和改动文件
- [ ] 检查 diff
- [ ] commit（仅在用户明确授权时）
- [ ] push / 创建 PR（分别获得明确授权时）
```

## 任务格式

复杂任务建议使用可追踪任务项：

```md
- [ ] T1: 修改字段校验
  - Goal / Acceptance: G1 / AC1
  - Planned Change: C1
  - Repository: `path/to/repository`
  - Files: `path/to/file`
  - Done When: 必填为空时阻止保存并提示
  - Verify: VT1（static）+ VT2（manual）
```

## Work Items 契约（持久任务）

持久任务的 `plan.md` 由 CLI 解析，必须带 frontmatter 和 `## Work Items` 章节：

```md
---
plan_version: 1
task_id: example-change
---

## Approach
（技术方案与权衡；非持久任务可省略 Work Items）

## Work Items

- [x] T1: 实现主题偏好读取
  - Stage: Implement
  - Planned Change: C1
  - Verify: VT1
  - Done When: 合法偏好能恢复，非法值回落到默认值
  - Evidence: VT1

- [ ] T2: 接入主题切换入口
  - Stage: Implement
  - Progress: active
  - Planned Change: C2
  - Verify: VT2
  - Depends On: T1
  - Done When: 切换后页面生效，刷新后保持
  - Checkpoint: 事件绑定已完成，刷新恢复尚未核实

## Deferred Work Items

- [ ] T9: 旧偏好迁移
  - Artifact: spec.md#Migration
  - Deferred Reason: 经范围修订移出当前任务
```

字段：`Stage`（必须属于当前任务路由）、`Progress`（`pending` / `active` / `blocked`；已勾选项必须省略）、
`Planned Change`（C，可多个）、`Verify`（VT，可多个）、`Depends On`（T，可多个或 `none`）、
`Done When`（完成条件，必填）、`Evidence`（VT 或任务相对文件定位符，完成时必需）、
`Checkpoint`（工作项级停点）、`Blocker`（仅 `blocked`）、`Artifact`（分析、评审等非代码工作项的交付物定位符）、
`Deferred Reason`（仅 `Deferred Work Items` 章节，且必须同时给出 `Artifact` 后续定位符）。

规则：

- 只有 `## Work Items` 和 `## Deferred Work Items` 被解析为进度事实源。其它章节（含上面的 Phase 清单）
  继续作为人读上下文，但不要把同一进度同时勾选在两处，否则以 Work Items 为准并修正。
- 同一任务最多一个 `active` 工作项；依赖不得自引用或成环；完成项必须带证据，阻塞项必须写原因。
- 工作项完成、阶段完成和整体验收完成是三个不同判断；T 全部勾选不会自动完成 Verify。
- 范围、目标文件或验收变化属于计划修订，必须保留修订原因；经明确范围修订移出的 T 进入
  `## Deferred Work Items`，不计入活动进度。
- 旧格式计划（无 frontmatter、只有 Phase 清单）不能直接用于持久任务：先补齐 frontmatter 与
  Work Items，或让任务保持 Conversation / Portable 而不启用持久化。

## Mini 配置

`Plan (mini)` 仍属于 Plan 阶段，不是独立阶段。它适用于 S 级 Spec 或低风险单点修改，可以与 Spec 合并表达，但至少包含：

- 目标文件和所属仓库。
- 一个或多个有序修改步骤。
- 每个步骤的完成条件。
- Review、静态验证和人工验证项。
- MCP / Playwright、CI 和人工验证的执行主体及前置条件。
- 明确不修改的范围。

## 执行规则

- 同一时间只推进一个主要阶段。
- 完成一个阶段后更新状态。
- 发现新风险时回到 Spec 或 PRD 修正。
- 用户中断或变更目标时，以最新用户指令为准。
- 一个任务完成后，立即标记状态，不等到最后集中更新。

## 通过标准

- 每个任务有明确完成条件。
- 实现前已经定位目标文件。
- 实现前已确认设计根因或需求不变量、规则责任层和最小完整方案。
- Review 和 Verify 不被合并省略。
- 每个需求至少能追踪到一个任务和一个验证项。
- 每个 AC 至少能追踪到一个 C 和一个 VT，且 ID 与 Spec / `verification.json` 一致。
- 每个任务已明确目标仓库；跨仓库任务按仓库拆分 Git 操作。
