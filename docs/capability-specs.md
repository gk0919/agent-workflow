# Capability Baselines and Task Deltas

本契约将长期能力规范与任务变更增量分开保存，阶段、批准、检查点和验证证据由 Core 统一管理。
它是可选能力：任务没有 `spec-change.json` 时，继续使用原来的 Spec / Plan 门禁。

## 事实源与保存

- 能力基线：工作区内独立 JSON 文件，建议 `.agent-workflow/specs/<capability>.json`，遵守
  [`capability-spec.schema.json`](../resources/schemas/capability-spec.schema.json)。是否纳入 Git 由项目决定。
- 任务增量：任务目录内 `spec-change.json`，遵守
  [`spec-change.schema.json`](../resources/schemas/spec-change.schema.json)，捕获来源路径、原始字节和 SHA-256。
- `spec.md` 解释行为场景与技术设计，`plan.md` 记录工作项，`verification.json` 保留唯一测试执行状态。
  不把规范库变成另一套任务状态机，不自动写入长期基线。

能力的 `R1` 等 ID 跨任务稳定，场景 `S1` 在一条需求内唯一；任务 AC / VT 是本次验收与验证 ID。
启用长期基线后用 `capability/R1 -> AC1 -> VT1` 映射，而不是用任务内 AC 身份替代长期需求身份。
未启用的任务继续沿用 Spec 中直接引用 AC 的方式。

基线示例（示例是尚未确认的观察，不代表产品事实）：

```json
{
  "schemaVersion": 1,
  "capability": "record-export",
  "status": "observed",
  "evidence": [],
  "requirements": [{
    "id": "R1",
    "statement": "只导出所选记录",
    "scenarios": [{
      "id": "S1",
      "when": "用户对已选记录执行导出",
      "then": "导出文件只包含所选记录"
    }]
  }]
}
```

`observed` 是代码或资料观察，`unknown` 是尚未确认，均阻止依赖完成。人工核对行为与来源证据后，
才把基线标为 `confirmed` 并填写 evidence。Core 检查状态与证据非空，不能证明人工是否确实核实，
不得把模型猜测标为 confirmed。首版没有自动发现、确认或晋升基线的命令。

## 捕获与增量

先用原 task CLI 建立持久业务任务。在 Plan 及之前运行：

```text
agent-workflow spec init --task <task-id> --baseline .agent-workflow/specs/record-export.json --expected-revision <N>
```

多能力可重复 `--baseline`；真正新增且没有基线的能力使用 `--capability <new-id>`。
是否已有能力需由来源与代码定位确认，不用“新能力”绕过存量规范。能力名不能重复。
命令仅捕获明确给出的来源，持有 manifest 锁并检查修订和仓库基线，发布原有 checkpoint；不修改基线文件。
任务在 Implement 及之后不能重新捕获，须按已有流程返回 Spec / Plan 并重新批准。

捕获后各能力 `changes` 为空，由 Agent 填入本次增量。每条增量使用：

```json
{
  "operation": "modified",
  "requirementId": "R1",
  "reason": "导出完成后需要明确反馈",
  "requirement": {
    "id": "R1",
    "statement": "只导出所选记录并显示完成反馈",
    "scenarios": [{
      "id": "S1",
      "when": "用户对已选记录执行导出且处理成功",
      "then": "文件只包含所选记录，并显示完成反馈"
    }]
  },
  "acceptanceIds": ["AC1"],
  "verificationIds": ["VT1"]
}
```

- `added` 的目标在基线中不得存在，`modified` / `removed` 的目标必须存在。
- 新增和修改给出完整 requirement，包括保留的场景；删除不给 requirement，reason 写明原因与替代/迁移依据。
- 同一能力的一条需求只能变更一次；没有被列出的基线需求保持原样。
- 所有 AC / VT 必须存在，引用的 VT 合起来覆盖该增量的所有 AC；VT 的 instructions / expected
  须由 Review 核对是否覆盖完整场景。结构化引用通过不等于语义覆盖正确。

修改任务产物沿用既有 checkpoint 发布机制；受控宿主可通过 `controller.artifact('spec-change.json', ...)`
提交增量，不能通过该接口修改长期规范。捕获阶段和模型作者身份不构成实施批准。

## 影响预览与依赖

```text
agent-workflow spec inspect --task <task-id>
agent-workflow spec inspect --task <task-id> --format json
```

输出当前增量字节的 `specChangeHash`、每条需求的 before / after（含场景）、变更原因、AC / VT，
以及依赖图：

```text
baseline:<capability> -> delta -> spec -> verification -> plan
```

- baseline：快照完整，存量来源已 confirmed，活动任务来源没有漂移；显式新增能力无需存量快照。
- delta：所有能力都有合法增量。
- spec：存在非空 `spec.md`，详细 frontmatter 与阶段内容仍交给原校验器与 Review。
- verification：原验证契约有效、引用有覆盖，并且绑定本次增量哈希。
- plan：原 plan 解析、工作项依赖与契约引用通过。

ready / blocked 每次从实际文件计算，不接受模型传入标志，不保存另一份完成状态。
inspect 只读；所有节点 ready 时退出 0，错误或 blocked 时退出 1；旧任务未启用时退出 0。
缺少 plan 可以阻止整张图 ready，但不会阻止 Spec 完成：Spec 完成需要到 verification 的依赖，
Plan 完成需要整张图。现有阶段转换、路由准入和 artifact 检查共用门禁。
Core 受控任务的结构化 status / delivery 的 task.specChange 也包含该预览，宿主可直接展示。

## 批准与证据绑定

启用本契约的任务使用 verification.json schemaVersion 2，并将 inspect 输出的哈希填入
可选字段 `specChangeHash`。增量每次修改后都需更新该字段；测试 instructions / expected 随实际场景修订。
增量文件参与现有 planHash，`specChangeHash` 参与验证 definitionHash：变更会使旧批准与旧验证失效，
重新记录 checkpoint 不会把旧测试自动变成 current。

活动任务的基线文件变化时，预览标为 blocked。人工审核变化后，在 Plan 及之前运行：

```text
agent-workflow spec refresh --task <task-id> --expected-revision <N>
```

refresh 更新已捕获的来源快照，保留增量；与新基线冲突的增量会被拒绝，须重新审查。
随后重新检查影响、更新验证哈希并发布产物。新快照不自动继承旧批准。
命令若写入后 checkpoint 发布失败，会保留未发布产物，按原有 reconcile 流程检查后恢复，不能盲重试。
已完成任务以捕获字节审计，不要求长期规范永远保持旧版本；活动阶段及完成转换仍检查实时来源。

## 执行边界

这是 Core 的产物依赖准入，不是 DSH 自动调度器。缺失或冲突的依赖阻止推进；模型是否能产出
正确内容仍需审查，任务不会因文件存在而自动执行或自动验收。长期规范归档合并、跨任务冲突解决、
图形影响预览和 DSH 自动调用捕获命令不在首版范围；长期规范更新需独立审核与授权。
