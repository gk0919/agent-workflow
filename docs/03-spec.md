# Spec

Spec 将需求的可观察行为与技术设计分开描述，并建立
[`verification-contract.md`](./verification-contract.md) 定义的目标与验证契约。

变更动机引用 Intake / PRD，行为和设计分节写在 `spec.md`，执行任务记录在 `plan.md`。

## 输入

Source Snapshot、Intake、按需 PRD、项目地图和相关代码。

## 输出模板

```md
# Change Spec

## 变更目的与边界
引用 Intake / PRD 和 G / OOS：为什么改变、影响哪些能力、哪些明确不做；不复制来源全文。

## 行为需求
按本次实际变化使用 ADDED / MODIFIED / REMOVED 分组；无变化的分组省略。
每条 Requirement 引用现有 AC ID，描述用户或调用方可观察的结果，不预先规定实现手段。
MODIFIED 写出变更后的完整规则和必须保留的行为；REMOVED 说明删除原因与替代或迁移方式。

### MODIFIED Requirements

#### Requirement: AC1 — 行为名称
系统必须……。引用现状证据；无法确认的原有行为标为待澄清。

##### Scenario: 场景名称
- GIVEN：有证据的前置条件（不需要时省略）。
- WHEN：用户操作或系统事件。
- THEN：可观察且可验证的结果。
- 验证：VT1；说明该测试点覆盖的结果，不声明尚未执行的通过状态。

## 技术设计

### 现状与责任层
目标仓库、模块、文件及现有数据流；说明根因或需求不变量及规则应归属的位置。

### 设计决策
描述选定方案、理由和确实存在的备选方案取舍；引用 C ID 和文件，不为凑模板发明备选。
只展开本次命中的接口、数据流、前后端或 UI 规范点；无关章节省略。

### 兼容、风险与回滚
说明必须保留的行为、已知风险及适用的回滚方式；未知项列为待澄清或验证缺口。
新增保护分支须对应可达场景及实际后果，不把假设转换为额外实现。

## 验证映射与待澄清
引用 verification.json 的 G / AC / C / VT、场景与证据缺口；不复制结构化契约全文。
影响验收或实施范围的问题未解决时保持 draft / conditional，不把它留给 Implement 猜测。
没有待澄清项时写明无；计划执行顺序与依赖留在 plan.md。
```

## 场景示例

以下只演示写法；AC / C / VT 的真实定义仍存于本任务的 `verification.json`。

```md
### MODIFIED Requirements

#### Requirement: AC1 — 导出所选记录
系统必须只导出用户当前选择的记录，导出字段保持现有定义。

##### Scenario: 导出两条已选记录
- GIVEN：用户已选中两条有权访问的记录。
- WHEN：用户执行导出。
- THEN：文件只包含这两条记录，字段与现有导出定义一致。
- 验证：VT1。

##### Scenario: 未选择记录
- WHEN：用户未选择记录就执行导出。
- THEN：提示用户选择记录，不生成导出文件。
- 验证：VT2。
```

每条需求至少一个具体场景；按已有事实补充适用的异常、权限、旧行为和边界场景，
不为每条需求机械生成全部分类。场景可引用同一 VT，前提是该 VT 明确覆盖其结果。
AC ID 保持稳定；改名或调整实现不新建一套 Requirement ID。

## 通过标准

- 可追踪到 Entry、Source Type 和目标仓库；Pool Entry 还包括 SN/ID。
- 已定位主要文件并说明现状与目标差异。
- 每个 AC 至少映射一个 Planned Change 和一个 Verification Test Point。
- 每条行为需求引用 AC 并具有可验证场景；每个场景指向覆盖其结果的 VT。
- 行为结果与技术手段分节；变更类型、保留行为和不做范围没有歧义。
- 风险、兼容和验证矩阵不为空；MCP 分别记录能力、授权和环境。
- 没有把产品问题留到实现阶段；高风险方案已确认。

## 自动落盘

正式 Spec 按 [`12-artifacts.md`](./12-artifacts.md) 保存最小包及 `verification.json`。
level-1 不触发落盘；升级进入 Spec 后开始遵守。只保存实际生成的可用产物。

`spec.md` 顶部使用：

```yaml
---
task_id:
entry_mode: pool | direct
source_type: demand | defect
source_sn:
spec_level: S | M | L
contract_version: 2
status: draft | conditional | confirmed
created_at:
updated_at:
---
```

`contract_version` 必须与 `verification.json` 的 `schemaVersion` 一致。当前要求版本 2
（含执行基线）；在 `routes.json` 的执行基线启用时间之前创建的 Spec 保留版本 1。

状态为 `draft`、`conditional` 或 `confirmed`；只有 `confirmed` 可以完成 Spec Gate。
继续澄清时更新同一文件。

契约由 Spec / Plan 建立、Implement 按 patch 更新、Verify 收口。历史兼容和启用时间以
`verification-contract.md` 为准。每次保存同步更新 manifest 阶段与 Next Action。

自动落盘只授权创建和更新任务产物，不授权 stage、commit、push 或创建 PR。

这是内容契约的更新，不新增 frontmatter 或 `verification.json` 字段。历史 Spec 保持可读，
不要求批量改写；修订历史任务时仅为本次变化补充场景。既有 Schema、引用和阶段门禁由 Core
校验；场景是否完整、设计是否合理由 Review 核对，不能把 Markdown 存在当作验收通过。
需要长期规范、基线快照和机器可读增量时，按需启用
[`capability-specs.md`](./capability-specs.md)。它提供影响预览与产物依赖准入，不自动合并长期规范。

## 设计深度

根据风险选择 Spec 深度：

| 等级 | 场景 | 需要内容 |
|------|------|----------|
| S | 单文件小修、文案、低风险样式 | AC 场景、最小设计决策、文件与 C/VT 引用 |
| M | 页面行为、表单校验、接口字段 | 适用的行为与边界场景、现状、设计、兼容风险与验证映射 |
| L | 跨模块、公共组件、数据结构 | 跨模块场景、数据流、接口、决策取舍、回滚与完整追踪 |
