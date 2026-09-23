# Routing Runtime Details

本文件是按需加载的 Reference：`ROUTER.md` 只保留分流决策，运行细节在这里。仅在需要时用
`--reference workflow:docs/routing-runtime.md` 加载，章节选择器见文件末尾。

## 任务入口与会话恢复

“我要换会话，帮我交接当前任务”对应 `agent-workflow task prepare`；“继续上次任务”对应
`agent-workflow task continue`。这是 Agent 内部入口：自动选择任务、推导 Entry、加载对应 Skill 和摘要。
会话或用户明确指定任务时附 `--task`，选定后所有写入和后续命令固定使用该 ID。
无明确 ID 时按 manifest Last Updated 与有效交接记录的生成时间选择最近未完成任务，不使用文件修改时间；
并列时仅询问任务选择。找不到本地任务但当前会话有完整任务事实时，按原路由的产物约定建立任务记录，
不要求用户填写文件或编造事实；确实缺少目标时才询问。

## 事实复核与阶段参数

`workflow:classify` 只预览结构化事实；`workflow:route` 会复核。等级 Route 缺完整 facts 时拒绝，
`--repository` 在 Locate 是可选提示、Implement 若传则匹配 Brief、Review 起强制绑定 patch；
Review 同时验证 Brief 文件、仓库和 patch。Windows 优先用 `--patch-file` 和 Git
`diff --output=<file>`，避免 PowerShell 管道；实际超 Gate 或来源绑定失败即升级。

## Implement 批准门禁

声明 `implementationApprovalRequired` 的 Route 进入 Implement 前必须先输出原因/依据、修改点和验证项
并结束回合，只有用户在当前会话明确批准后才可追加 `--user-approved`；缺少批准、在该 Route 未声明
门禁时使用该参数、或在非 implement 阶段使用该参数都会被确定性拒绝。门禁由 `routes.json` 声明，
`route --stage implement`、`next`、`advance` 与 `reopen --to Implement` 共用同一声明，不按 Route 名判断。
持久任务在同一已批准计划上恢复时不必重新展示完整 Implementation Review，但进入 Implement 仍必须由
当前会话用户确认；激活工作项由 `workItemApprovalRequired` 单独声明，且只在存在计划批准记录时生效
（见 [`12-artifacts.md#持久任务persistent`](./12-artifacts.md#持久任务persistent)）。

## Run 血缘与归属

Packet 自动生成 Run ID；同 Route 后续阶段复用该 ID，切 Route 时在新 Route 首阶段改用
`--parent-run-id <old-run>` 创建关联的新 Run。运行日志会校验阶段顺序、Route 归属、Brief
计划哈希和匿名来源哈希；其他 Route 可人工分流，但决策标为 `manual-route-selection`。
交接是临时操作路由，不改变目标任务的 manifest Route；路由不传 `--task`，随后交接命令传目标任务 ID。
`task-handoff` 与 `task-portable-resume` 按阶段能力从 Profile 的 `capabilitySkills` 加载 Skill，
并计入预算；具体 Skill 定位符不写入 Core。

## Reference 加载与风险标识

加载深度 Reference 时重新运行 Route 并追加 `--reference`；只有当前阶段白名单允许，
且 Reference 会重新计入上下文预算。长文档使用 `path#heading` 章节选择器，禁止为了读取
一个规则把整份维护手册加入上下文。命中明确风险时追加 `--risk <flag>`；等级 0/1 遇到禁止风险
会确定性拒绝并给出升级动作。优先使用 `--materialize`；超限时完整物化可容纳的优先项并列出剩余。
三份基础文档不会重复输出。
