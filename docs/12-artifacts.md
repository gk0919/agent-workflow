# Task Artifacts and Repository Context

本文件定义阶段产物的保存方式、任务标识、多仓库上下文和跨工具交接。目标是保证可追踪，同时避免默认向仓库写入大量临时文档。

## 默认保存策略

- Conversation 状态模式默认只在当前对话中输出阶段产物，不主动创建任务文件。
- 标准流程业务任务生成正式 Spec 是唯一默认落盘例外：立即创建或更新最小 Spec 包
  `manifest.md`、`source.md`、`intake.md`、`spec.md` 和 `verification.json`。
- Micro Change 只保留对话内 Source Lite 与 Change Brief，不生成正式 Spec，也不创建任务目录；需要落盘或交接时先升级标准流程。
- 用户明确要求“落盘”“保存过程”“可追溯记录”时，才在仓库中创建任务目录。
- 用户明确表示任务可能切换工具、需要异步执行、云端交付或长期交接时，进入 Portable 状态模式并创建任务目录。
- 不为已跳过的阶段创建空文件；在 `manifest.md` 中记录跳过原因。
- 创建任务目录不等于授权把任务产物加入 Git，不等于授权 stage、commit、push 或创建 PR。

正式 Spec 自动落盘由项目策略预先授权，不需要每个任务重复询问。它只覆盖 `.agent-workflow/tasks/local/<task-id>/` 内的任务产物。

## 任务目录

需要落盘时，统一保存到包含 `.agent-workflow` 的顶层工作区根目录：

```text
.agent-workflow/tasks/local/<task-id>/
├── manifest.md
├── source.md
├── intake.md
├── prd.md
├── spec.md
├── verification.json
├── plan.md
├── change-summary.md
├── review.md
├── verify.md
├── ci-verification.json
├── checkpoint.json
├── history/revision-<n>/
├── verification-start/<VT-id>.json
├── manifest-legacy.md
├── handoff.md
└── git-report.md
```

`checkpoint.json`、`history/`、`verification-start/` 和 `manifest-legacy.md` 只属于持久任务，
由 CLI 维护，见 [`持久任务`](#持久任务persistent)。

`task-id` 推荐格式：

```text
YYYYMMDD-<issue-id-or-short-slug>
```

只使用小写字母、数字和连字符；已有需求或缺陷编号时优先使用编号，例如 `20260724-defect-12345`。

目标目录已存在时，只有 Source Record 相同时才复用；不同来源发生命名冲突时追加 `-02`、`-03`，不得覆盖其他任务。

## Manifest

`manifest.md` 是所有 Portable 任务的必需文件。业务任务还必须有 `source.md`，其他文件根据任务路由按需创建。

Conversation 业务任务如果到达 Spec 阶段，也必须创建：

- `manifest.md`
- `source.md`
- `intake.md`
- `spec.md`
- `verification.json`

任务完成时可使用以下命令自动收敛 manifest 生命周期字段。命令先在内存中执行完整产物检查，
通过后持有同目录锁并原子替换 manifest；唯一的 `in_progress` 阶段不满足收口条件时不会覆盖原文件：

```text
npm run workflow:task -- complete --task <task-id> --evidence <completion-evidence>
```

恢复任务前先输出受限摘要，避免把全部历史产物塞入上下文：

```text
npm run workflow:task -- summary --task <task-id>
```

其他生命周期命令：

```text
npm run workflow:task -- start --task <task-id> --action <next-action>
npm run workflow:task -- advance --task <task-id> --to <stage> \
  --evidence <completion-evidence> --action <next-action>
npm run workflow:task -- skip --task <task-id> --stage <optional-stage> --reason <reason>
npm run workflow:task -- block --task <task-id> --reason <blocker>
npm run workflow:task -- resume --task <task-id> --action <next-action>
```

`Plan -> Implement` 必须先向用户展示 Implementation Review 并获得当前会话的明确批准，随后
在 `advance` 命令追加 `--user-approved`；该参数不能用于其他目标阶段。

持久任务在同一已批准计划上恢复时，不需要重新展示完整的 Implementation Review，但任务记录
不是授权证明：进入 Implement（`advance`、`reopen --to Implement`、`next`、`route --stage implement`）
和激活工作项（`task item --status active`）仍必须由当前会话用户确认，并附 `--user-approved`，
批准依据写入 `--approval-source`，不能用占位文本。记录中的批准只用于判断计划、范围和边界
是否仍然适用；Git 与外部写入继续独立授权。

多执行者或跨工具接力时，从 Resume Summary 取得 `Last Updated`，并在写命令追加
`--expected-last-updated <date-time>`。值已变化时命令拒绝覆盖；同一时刻的并发命令由
`manifest.md.lock` 阻断，异常遗留锁需人工核对执行者状态后处理。

后续 Plan、Review、Verify 和 Git Report 在 Conversation 模式下仍默认保留在对话中；用户要求完整落盘或任务切换为 Portable 时，再保存对应文件。

```md
# Task Manifest

## Identity
- Schema Version: 1
- Task ID:
- Run ID: `run-<random-id>`
- Source:
- Type:
- Mode: Pair / Async / Runtime
- State Mode: Conversation / Portable
- Route:
- Route ID: `standard-change` / `analysis` / `review-only`
- Status:
- Current Stage:
- Last Executor:
- Last Updated:

## Source Record
- Entry Mode: pool / direct / not applicable
- Type: demand / defect / not applicable
- SN: Pool Entry 必填；Direct Entry 可选
- ID: Pool Entry 有值时记录；Direct Entry 可选
- Capture Method:
- Captured At:
- Freshness:
- Snapshot: source.md

## Scope
- Goal:
- In Scope:
- Out of Scope:

## Repository Matrix
| Repository | Root | Module | Branch | Remote | Allowed Git Actions |
|------------|------|--------|--------|--------|---------------------|
|  |  |  |  |  | Inspect |

## Worktree Binding
| Repository | Binding ID | Base Commit | Checkout Mode | Branch |
|------------|------------|-------------|---------------|--------|
|  |  |  | detached / branch | none / branch-name |

## Stage Status
| Stage | Status | Artifact / Reason |
|-------|--------|-------------------|
| Source Capture | pending / in_progress / complete / blocked / skipped | 业务任务不得 skipped |
| Intake | pending / in_progress / complete / blocked / skipped | |
| Analyze | pending / in_progress / complete / blocked / skipped | 仅分析路由使用 |
| PRD | pending / in_progress / complete / blocked / skipped | |
| Spec | pending / in_progress / complete / blocked / skipped | |
| Plan | pending / in_progress / complete / blocked / skipped | |
| Implement | pending / in_progress / complete / blocked / skipped | |
| Review | pending / in_progress / complete / blocked / skipped | |
| Verify | pending / in_progress / complete / blocked / skipped | |
| Git Inspect | pending / in_progress / complete / blocked / skipped | |

## Authorization
- Persist Artifacts:
- Worktree Create:
- Worktree Branch:
- Worktree Remove:
- Git Stage:
- Commit:
- Push:
- PR:

## Resume
- Last Completed Stage:
- Next Pending Stage:
- Next Action:
- Suggested Follow-up:
- Required Inputs:
- Known Blockers:
- Working Tree Notes:
```

`Last Executor` 只记录工具或执行者类型，例如 `Codex`、`Qoder`、`TRAE`、`Human`，不记录账号、令牌或设备信息。

业务任务的 `task-id` 优先使用：

```text
YYYYMMDD-demand-<sn>
YYYYMMDD-defect-<sn>
YYYYMMDD-direct-<short-slug>
```

`source.md` 按 `agent-workflow/docs/source-capture.md` 保存完整 Source Snapshot。缺少它时，Portable 业务任务不得进入 Intake。

`spec.md` 按 `agent-workflow/docs/03-spec.md` 保存等级、状态和完整技术方案。Spec Gate 变化后必须更新同一文件。

新 Spec 在 frontmatter 声明 `contract_version`，并使用 `verification.json` 保存
Goal & Verification Contract；当前要求版本 2，启用时间与兼容规则见
[`verification-contract.md`](./verification-contract.md#执行基线版本-2)。历史 Spec 没有版本字段时保持兼容；声明版本后该文件为必需产物。

## Portable 模式

以下任一条件成立时使用 Portable 模式：

- 用户说明可能切换 Coding Agent。
- 任务需要跨会话继续。
- 任务由后台或云端 Agent 异步执行。
- 业务代码需要同时修改两个及以上 Git 仓库，或任务持续时间较长。
- 用户明确要求过程可追踪或可交接。

根工作区只保存自动生成的最小 Spec 包、业务代码只修改一个子仓库时，不因产物与代码分属两个仓库而自动进入 Portable；应在 Repository Matrix 中同时记录两者。

Portable 模式要求：

1. 开始执行前创建或读取 `manifest.md`；业务任务同时读取或创建 `source.md`。
2. 每完成一个阶段，立即更新 `Stage Status` 和 `Resume`。
3. 关键决策写入对应阶段产物，不依赖聊天上下文。
4. 修改代码后从任务 patch 更新 `verification.json` 的 Actual Changes、Review 和 VT 状态。
5. 工具切换或显式交接前使用 task-handoff 路由生成交接包并检查。阶段推进更新 manifest 的最小检查点，不要求每一步重写完整交接包。

## 持久任务（Persistent）

`State Mode: Persistent` 的任务（manifest `Schema Version: 2`）以 `checkpoint.json` 作为已发布
修订的标记，全部写入由 CLI 完成，不手工编辑检查点：

```text
agent-workflow task init --task <task-id> --route <route> --entry <entry> --goal <text> [--repository <path>] [--source-type <type> --source-text <text>]
agent-workflow task status --task <task-id> [--format json]
agent-workflow task checkpoint --task <task-id> --expected-revision <n> --reason <text> [--reconcile]
agent-workflow task item --task <task-id> --item <T-id> --status <pending|active|blocked|complete> \
  --expected-revision <n> --reason <text> [--checkpoint <text>] [--evidence <locator>[,<locator>]] [--user-approved]
agent-workflow task verify-begin --task <task-id> --test <VT-id> --evidence <file>#<section> \
  --environment <text> --expected-revision <n> --reason <text>
agent-workflow task verify-record --task <task-id> --test <VT-id> \
  --status <passed|failed|blocked|not-applicable> [--evidence <file>#<section>] \
  --expected-revision <n> --reason <text>
agent-workflow task migrate --task <task-id> --reason <text> [--user-approved --approval-source <text>]
```

规则：

1. 每个写入都必须提供 `--expected-revision`；修订号不符时拒绝覆盖。
2. `checkpoint.json` 记录修订号、产物哈希、仓库指纹、路由定义哈希、批准记录和 `route.reconstructed`。
   它是发布标记，不是测试结论，也不授予任何权限。
3. 每次发布前把产物快照写入 `history/revision-<n>/`。历史目录只读，用于核对被拒绝或中断的写入。
4. 未发布的产物变动会在下一次检查中报 `Unpublished task changes`；先核对差异，再用
   `checkpoint --reconcile` 修复，不根据未发布的 manifest 继续推进阶段。
5. `verify-begin` / `verify-record` 登记并核验执行基线，规则见
   [`verification-contract.md#执行基线版本-2`](./verification-contract.md#执行基线版本-2)。
6. 旧任务迁移保留 `manifest-legacy.md` 原文。没有可核实 runtime 血缘时，只有用户明确确认的
   重建迁移才被接受，并在检查点标记 `reconstructed: true`；`task status` 的 `continuity` 与
   `warnings` 会报告该缺口，恢复时先重新核对产物、代码与批准来源。
7. 任务目录仍属于忽略的本地数据；`history/` 随发布次数增长，按任务数据保留，CLI 不自动清理。

## Handoff

日常只需向 Agent 说“我要换会话，帮我交接当前任务”，新会话说“继续上次任务”。以下命令和文档维护均由 Agent 完成。
内部入口分别为 `agent-workflow task prepare` 和 `agent-workflow task continue`，不需要用户提供任务 ID、Entry 或手工加载 Skill。会话已有明确任务时 Agent 附 `--task`；否则选择最近未完成任务，仅在同样最近的候选并列时询问。
`task current --format json` 返回选择结果和候选；`summary`、`handoff`、`handoff-check` 也支持省略 ID，但多步操作应固定入口返回的 ID。
选择依据是 manifest Last Updated 和有效交接记录生成时间，不使用文件 mtime；已完成任务不参与自动选择，显式 ID 不会回退到其他任务。损坏记录会报告错误，不能静默跳过后选中另一任务。
`task continue` 加载恢复上下文并检查交接新鲜度，不修改生命周期，不自动执行 Git 写入。无任务记录时由 Agent 根据会话事实按原任务路由建立记录。

交接由流程调度、Skill 整理判断、CLI 汇总和校验事实。Profile 的 `capabilitySkills` 将阶段能力绑定到包内或项目 Skill 定位符。
业务阶段仍以 manifest 为唯一生命周期事实源，验证以 verification contract 为准；交接不授予额外权限。

交接包由三份文件组成：

- `handoff-notes.md`：执行者维护的检查点、决策依据、失败尝试、未知项、接手步骤和必读证据。
- `handoff.md`：CLI 生成的完整阅读视图，汇总 manifest、source、verification 和 notes，不直接手工编辑。
- `handoff-state.json`：版本化新鲜度记录，绑定产物哈希、生成文档哈希、仓库 HEAD、分支及已暂存/未暂存/未跟踪改动指纹。任务目录从仓库指纹中排除，其文件单独校验。

先根据当前证据填写 notes，再执行：

```text
agent-workflow route --route task-handoff --stage prepare --entry <entry> --materialize
agent-workflow task handoff --task <task-id>
agent-workflow task handoff-check --task <task-id>
```

目标任务必须已有 manifest 和明确的 Repository Matrix。Git 检查只读，不自动暂存或提交。
下面是 notes 的内容契约；不能只保留占位标题，无失败或无决策时说明原因：

```md
# Handoff Notes

## Checkpoint
- 准确停点、环境前提、任务改动与原有改动的边界。

## Decisions
- 已选方案、证据、必要的替代方案，以及重新评估条件。

## Attempts / Unknowns
- 已尝试路径及实际结果、尚未证实的假设、阻塞和解除条件。

## Next Steps
- 按顺序记录动作、执行位置、预期结果和停止条件；第一步必须能直接执行。

## Required Context
- `manifest.md#Scope`：确认目标与范围。使用任务相对文件路径和准确的二级标题，补充阅读原因。
```

`task summary` 默认最多 8000 字符，整节延后并列出定位符，不截断章节中间内容。
使用 `--section <file>#<section>` 展开 Markdown 二级标题或 JSON 顶层字段；`--format json` 返回完整摘要结构和警告。
旧版 handoff 继续可读，其 Required Context 和 Authorization 也进入摘要；首次迁移保留 `handoff-legacy.md` 原文，并在摘要中提供入口。迁移前整理有效判断和授权来源，旧文档不能被视为已通过新鲜度检查。
检查发现版本变化时先重新判断受影响结论，不得仅重新生成来清除警告。产物结构检查与恢复新鲜度检查分离，正常阶段推进不会因上一次交接过期而被锁住。

接手任务的执行者必须：

1. 使用 `portable-resume` Packet，只读取 `manifest.md` 的状态小节、`source.md` 摘要、
   `verification.json` 的目标/未完成 VT 摘要和 `handoff.md` 当前事项。
2. 只读检查实际仓库状态，确认分支和改动文件与记录一致。
3. 不重复执行已完成阶段；发现记录与仓库不一致时，以仓库事实为准并更新记录。
4. 有 `in_progress` 或 `blocked` 阶段时先处理 `Current Stage`；否则从第一个 `pending` 阶段继续。
5. 不继承聊天中未落盘的完成结论、验证结果或 Git 授权。

推荐启动提示：

```md
请按仓库 `AGENTS.md` 声明的实际 `START.md` 包路径选择 portable-resume，只读取
`.agent-workflow/tasks/local/<task-id>/manifest.md`、业务任务 `source.md` 和 `handoff.md`
的当前状态摘要。
先只读核对仓库状态；有 in_progress / blocked 阶段时先处理 Current Stage，
否则从第一个 pending 阶段继续。
不要重复已完成工作，不要继承未写入任务产物的验证结论或 Git 授权。
```

## 多仓库上下文

本项目包含根仓库和多个业务子仓库。执行前必须：

1. 为每个目标文件确认所属 Git 仓库根目录。
2. 按仓库对改动文件分组。
3. 在 Repository Matrix 中分别记录分支、远端和授权动作；`Root` 使用相对顶层工作区的稳定路径，不保存机器绝对路径。
4. Review 和 Verify 可以形成一份汇总报告，但 Git Report 必须按仓库分节。
5. stage、commit、push 和 PR 授权按仓库、按动作分别判断。
6. 使用 worktree 时，在 Worktree Binding 记录逻辑仓库、Binding ID、基线 commit 和 checkout mode；每个仓库一行。

禁止：

- 在仓库归属不明时提交。
- 从根目录用一次 Git 操作概括多个独立子仓库。
- 把一个仓库的 commit 或 push 授权扩展到另一个仓库。
- 把用户已有改动混入任务提交。

`Remote` 只记录 `origin` 等远端名称，不记录可能包含凭据的远端 URL。

任务产物不得把某台机器的绝对路径作为仓库唯一标识。确需记录本机位置时放入 `Working Tree Notes`，并同时保留稳定的仓库相对路径。
本机 worktree 绝对路径只保存在已忽略的 `runtime/worktrees/<task-id>.json`；该文件不属于 Portable 任务事实，恢复时必须用实际 Git 状态重新核对。

## 状态与生命周期

- Manifest `Status` 使用 `pending / in_progress / blocked / complete`。
- 同一时间最多一个阶段为 `in_progress`；该阶段应与 `Current Stage` 一致。
- `pending` 任务的 `Current Stage` 和 `Next Pending Stage` 均指向第一个未完成阶段。
- `blocked` 任务只能有一个 `blocked` 阶段，并与 `Current Stage` 一致。
- 被路由跳过的阶段标记 `skipped` 并说明原因；不属于当前路由的 Analyze 等可不出现在表中。
- 阶段完成后立即更新 `manifest.md`，不在任务结束时集中补写。
- 阶段状态通过 `workflow:task start/advance/skip/block/resume/complete` 更新；多执行者接力时传入
  `--expected-last-updated`。不得绕过 Route 的合法转换。Manifest 的抽取结构遵守
  `schemas/task-manifest.schema.json`。
- 用户改变目标时，更新 Scope 和 Route，并保留变更原因。
- 任务完成后将 Status 和 Current Stage 标为 `complete`，`Next Pending Stage` 与 `Next Action` 标为 `none`，未验证项写入 Verify 或 `Suggested Follow-up`。
- 任务受阻时记录阻塞事实和所需输入，不把推断写成结论。
- 工具切换时记录旧工具、接手工具、交接时间和实际仓库差异。
- 是否把任务产物加入 Git 提交由用户单独决定。

## 安全

- 产物中不得记录访问令牌、Cookie、签名 URL、请求头或其他凭据。
- 外部系统内容只保留完成任务所需的最小信息。
- 日志或截图涉及敏感信息时，先脱敏再落盘。
