# Runtime Router

只用本页完成首次分流；运行细节与规则见 [`routing-runtime.md`](./routing-runtime.md)，按需加载。

## Entry

- 用户要求查询、展开、选择或刷新项目 Provider 中的事项：使用 Active Profile 的 Provider Entry（默认名为 `pool`）；调用 Route Packet 声明的 Source Provider，未明确要求时不得刷新。
- 用户直接提供自包含需求或缺陷：`direct`；不得调用缺陷池补全。
- 用户要求生成候选知识、检查候选知识或确认候选可晋升：`not-applicable`；路由到 `task-workflow-maintenance`，不调用缺陷池。
- 工作流维护、工具配置、纯 Git：`not-applicable`。

业务事实先形成 Source Lite：来源、目标/现象、期望结果、明确限制；Pool 另记录 SN/ID 和捕获时间。缺少关键事实时只问一个必要问题。

## Route

| 条件 | Route / First Stage |
|---|---|
| 只查询或选择池事项 | `task-pool-capture / capture` |
| 纯外观改动 | `level-0 / locate-cosmetic` |
| 明确低风险微变更，满足通用 Gate；缺陷恢复既有行为 | `level-1 / locate-defect` |
| 明确低风险微变更，满足通用 Gate，且需求复用现有模式、不新增业务状态、兼容策略明确 | `level-1 / locate-requirement` |
| 业务修改，单模块（`modules ≤ 1`）且无跨模块风险 | `level-2 / capture` |
| 跨模块（`modules ≥ 2`）或命中 `state-refactor` / `performance-program` | `level-3 / capture` |
| 跨模块或跨仓库的架构级公共契约、数据模型、权限边界、异步生命周期或迁移发布变化 | `level-4 / capture` |
| 只分析或定位 | `task-analysis / capture` |
| 只评审 | `task-review / capture` |
| 工作流或工具维护 | `task-workflow-maintenance / inspect` |
| 纯 Git | `task-git / inspect` |
| 恢复已有 Portable 任务 | `task-portable-resume / resume` |
| 用户要求交接、换会话或切工具 | `task-handoff / prepare` |

等级即入口：`--level <0-4>` 选中 `level-N`，`--route` 可选且同时给出时必须一致；五个等级都要求
`--intent` 与完整 Gate 事实，阈值以 `routes.json` 为唯一事实源。事实是下限：声明低于事实推导等级
会被拒绝并给出应改用的 `level-N`，声明更高则按更严流程执行。

目标、验收、唯一落点和验证入口必须明确，且无接口、数据、权限、公共链路、异步生命周期、高风险、
迁移、发布协同或外部写入。截图、样式或业务语义有歧义时不得进入。执行中范围扩大时先升级 `level-2`。
L4 也可由 `--intent architecture` 进入。

## Runtime

```text
npm run workflow:classify -- --intent <intent> [--change-type defect|requirement|cosmetic] --entry <entry> [fact flags]
npm run workflow:next -- --task <task-id> [--materialize] [--user-approved]
npm run workflow:route -- --level <0-4> [--route <route>] --stage <stage> --entry <entry> \
  --intent <intent> <fact flags> [--brief-file <path>] [--patch-file <path> | --patch-stdin] \
  [--repository <relative-repository>] [--run-id <id> | --parent-run-id <id>] [--materialize]
```

只加载输出白名单；`README.md`、`source-capture.md`、Active Profile 的项目策略、`level-1.md` 和完整
Reference 默认禁止启动时读取。阶段切换后丢弃上一阶段的流程细节，仅保留任务事实、决策、diff 和未完成项。
