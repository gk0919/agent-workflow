# Runtime Router

只用本页完成首次分流；详细说明按 Route Packet 延迟加载。

## Entry

- 用户要求查询、展开、选择或刷新项目 Provider 中的事项：使用 Active Profile 的 Provider Entry（默认名为 `pool`）；调用 Route Packet 声明的 Source Provider，未明确要求时不得刷新。
- 用户直接提供自包含需求或缺陷：`direct`；不得调用缺陷池补全。
- 用户要求生成候选知识、检查候选知识或确认候选可晋升：`not-applicable`；路由到 `workflow-maintenance`，不调用缺陷池。
- 工作流维护、工具配置、纯 Git：`not-applicable`。

业务事实先形成 Source Lite：来源、目标/现象、期望结果、明确限制；Pool 另记录 SN/ID 和捕获时间。缺少关键事实时只问一个必要问题。

## Route

| 条件 | Route / First Stage |
|---|---|
| 只查询或选择池事项 | `pool-capture / capture` |
| 明确低风险微变更，满足通用 Gate；缺陷恢复既有行为 | `micro-change / locate-defect` |
| 明确低风险微变更，满足通用 Gate，且需求复用现有模式、不新增业务状态、兼容策略明确 | `micro-change / locate-requirement` |
| 业务修改但不满足 Micro Change | `standard-change / capture` |
| 只分析或定位 | `analysis / capture` |
| 只评审 | `review-only / capture` |
| 工作流或工具维护 | `workflow-maintenance / inspect` |
| 纯 Git | `git-only / inspect` |
| 恢复已有 Portable 任务 | `portable-resume / resume` |

Micro Change 数量阈值以 `routes.json` 的 `microChangeGate` 为唯一事实源；目标、验收、唯一落点和验证入口必须明确，且无接口、数据、权限、公共链路、异步生命周期、高风险、迁移、发布协同或外部写入。截图、样式或业务语义有歧义时不得进入。执行中范围扩大时先升级 `standard-change`。

## Runtime

运行：

```text
npm run workflow:classify -- --intent <intent> \
  [--change-type defect|requirement] --entry <entry> [fact flags]
npm run workflow:next -- --task <task-id> \
  [--skill <name>] [--reference <path>] [--risk <flag>] [--repository <path>] \
  [--format text|json] [--materialize] [--user-approved]
npm run workflow:route -- --route <route> --stage <stage> --entry <entry> \
  [--intent <intent> <fact flags>] [--skill <name>] [--reference <path>] \
  [--run-id <id> | --parent-run-id <id>] \
  [--micro-brief-file .agent-workflow/runtime/briefs/<name>.json] \
  [--micro-patch-stdin | --micro-patch-file .agent-workflow/runtime/patches/<name>.patch] \
  [--repository <relative-repository>] [--user-approved]
```

`workflow:classify` 只预览结构化事实；`workflow:route` 会复核。Micro 缺完整 facts 时拒绝，
`--repository` 在 Locate 是可选提示、Implement 若传则匹配 Brief、Review 起强制绑定 patch；
Review 同时验证 Brief 文件、仓库和 patch。Windows 优先用 `--micro-patch-file` 和 Git
`diff --output=<file>`，避免 PowerShell 管道；实际超 Gate 或来源绑定失败即升级。
Micro 和 Standard 进入 Implement 前必须先输出原因/依据、修改点和验证项并结束回合；只有用户
在当前会话明确批准后才可追加 `--user-approved`。缺少批准或在其他阶段使用该参数均被拒绝。
Packet 自动生成 Run ID；同 Route 后续阶段复用该 ID，切 Route 时在新 Route 首阶段改用
`--parent-run-id <old-run>` 创建关联的新 Run。运行日志会校验阶段顺序、Route 归属、Brief
计划哈希和匿名来源哈希；
其他 Route 可人工分流，但决策标为 `manual-route-selection`。
加载深度 Reference 时重新运行 Route 并追加 `--reference`；只有当前阶段白名单允许，
且 Reference 会重新计入上下文预算。长文档使用 `path#heading` 章节选择器，禁止为了读取
一个规则把整份维护手册加入上下文。

命中明确风险时追加 `--risk <flag>`；Micro Change 遇到禁止风险会确定性拒绝并给出升级动作。
优先使用 `--materialize`；超限时完整物化可容纳的优先项并列出剩余。三份基础文档不会重复输出。

只加载输出白名单；`README.md`、`source-capture.md`、Active Profile 的项目策略、`micro-change.md` 和完整 Reference 默认禁止启动时读取。阶段切换后丢弃上一阶段的流程细节，仅保留任务事实、决策、diff 和未完成项。
