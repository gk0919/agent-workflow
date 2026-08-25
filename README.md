# AI Workflow

第一次接触本工作流，建议先阅读 [`BEGINNER-GUIDE.md`](./docs/BEGINNER-GUIDE.md)。它从任务分流、Micro Change、标准流程、质量门禁和实际案例开始讲解，不要求预先了解 Agent。

这是一套模型无关、工具无关的 AI 协作工作流。它的目标不是绑定某个 IDE、MCP 或 Agent 框架，而是让任何执行者都能按同一套阶段、产物和门禁推进需求或缺陷。

`agent-workflow/` 是流程协议，不是某个 Agent 的提示词集合。工具专属规则只负责启动、能力映射和降级，不得重新定义阶段、项目规范、授权边界或任务状态。

跨工具唯一技术启动入口是 [`START.md`](./docs/START.md)。运行时由 [`ROUTER.md`](./docs/ROUTER.md) 和 [`routes.json`](./resources/routes.json) 选择当前阶段卡；本 README 是人类维护手册，不属于启动上下文。

业务任务先用 [`cards/source-lite.md`](./resources/cards/source-lite.md) 捕获最小事实。Pool Entry 从本地需求池/缺陷池读取，Direct Entry 直接使用用户粘贴的自包含内容；只有复杂捕获、落盘或降级时才读取 [`source-capture.md`](./docs/source-capture.md)。

## 分发与安装

包名为 `@gk0919/agent-workflow`。GitHub Actions 在 Pull Request、`main` Push、`v*` Tag 和手动触发时，先在 Node.js 20/22/24 上运行完整政策门禁，再执行 `npm pack`、安装打包结果做 CLI 冒烟检查，并上传 `.tgz` 构件；流水线不自动发布包。

```sh
# 从 Actions 下载构件后安装固定文件
npm install --save-dev ./gk0919-agent-workflow-1.0.0.tgz

# 同级仓库开发时使用 npm file dependency
npm install --save-dev ../agent-workflow

# 初始化宿主契约，再生成/检查当前项目的 Agent 薄入口
npm exec --no -- agent-workflow init
npm run workflow:setup
npm run workflow:init:check
npm run workflow:setup:check
```

宿主项目应把包声明在 `devDependencies`，脚本只调用 `agent-workflow <command>`。不要引用 `node_modules` 中的 `src/` 文件，也不要复制 Core。GitHub Packages 的发布配置已声明，但 `npm publish`、Release、Tag 和推送都需要独立授权。

## 指令优先级与加载顺序

发生冲突时，按以下优先级处理：

1. 安全、权限、合规和组织级约束。
2. 当前用户明确指令。
3. `AGENTS.md` 中的仓库级强制约束。
4. `agent-workflow/` 的通用内核与 `.agent-workflow/profile/` 的项目策略。
5. 工具适配规则。
6. 个人偏好和历史经验。

适配器与工具记忆不是事实源。出现冲突时不得静默选择，按 [`10-instructions-as-code.md`](./docs/10-instructions-as-code.md) 的优先级处理并记录冲突。

文件按“薄入口、当前阶段、按需 Reference”加载。始终加载集合只有 `AGENTS.md`、`START.md` 和 `ROUTER.md`；阶段卡和命中 Skill 由 Route Packet 白名单给出。完整项目策略、Adapter、阶段手册和 Reference 只有当前卡明确需要时才读取。

## 启动与任务分流

执行任务前先识别任务类型和风险，再选择最小充分流程。不得为了套用模板给简单任务增加无价值产物，也不得用“简化流程”为由跳过必要的 Review 和 Verify。

| 任务类型 | 默认流程 | 说明 |
|----------|----------|------|
| 查询、搜索、选择池中需求或缺陷 | Pool Source Capture -> Report / Selection | 只读本地数据；刷新和状态写入需单独授权 |
| 明确、低风险且满足全部 Micro Change Gate 的缺陷或小型需求 | Source Lite -> Change Brief -> Implement -> Review (focused) -> Verify (targeted) -> Git Inspect | 先区分 `defect` / `requirement`；Conversation 模式不生成任务目录，任一升级条件命中即切回标准流程 |
| 直接粘贴的简单需求或缺陷（不满足 Micro Change） | Direct Source Capture -> Intake (lite) -> Spec (S) / Plan (mini) -> Implement -> Review -> Verify -> Git Inspect | 不调用 MCP；按风险压缩文档 |
| 需求/缺陷分析、调研、代码定位 | Source Capture -> Intake (lite) -> Analyze | 不修改文件；Analyze 产出 Analysis Report |
| 需求/缺陷代码评审 | Source Capture -> Intake (lite) -> Review -> Verify (gaps-only) | 默认只读；用户另行要求时才修复 |
| 需求/缺陷低风险修改 | Source Capture -> Intake (lite) -> Spec (S) / Plan (mini) -> Implement -> Review -> Verify -> Git Inspect | PRD 可省略，Spec 和 Plan 可合并 |
| 普通需求 / 缺陷修复 | Source Capture -> Intake -> PRD（按需）-> Spec -> Plan -> Implement -> Review -> Verify -> Git Inspect | 行为变更必须有可测试验收标准 |
| 跨模块 / 公共组件 / 数据结构 / 高风险改动 | Source Capture -> Intake -> PRD -> Spec -> Plan -> Implement -> Independent Review -> Verify -> Git Inspect | 关键门禁需要人工确认 |
| 工作流维护 / 工具配置 / 非业务仓库操作 | Intake (lite) -> Plan（按需）-> Implement -> Review -> Git Inspect | 不伪造需求或缺陷记录 |
| 纯 Git 操作 | Intake (lite) -> Git | 只执行用户明确授权的 Git 动作 |

`Git Inspect` 只包含只读的仓库定位、`status` 和 `diff` 检查。`stage`、`commit`、`push`、创建 PR 和合并均为独立授权动作，不因完成实现或进入 Git 阶段而自动获得授权。

## Micro Change

Micro Change 是独立风险路由，不是把标准流程的每个阶段各写短一点。运行时通用门禁见 [`cards/micro-change.md`](./resources/cards/micro-change.md)，意图差异见 `intent-defect.md` / `intent-requirement.md`；[`micro-change.md`](./docs/micro-change.md) 只作为深度参考。

- Source Capture 仍是业务任务的强制入口。
- 缺陷使用 Defect Brief，记录现象、根因证据、范围、回归点和验收结果。
- 小型需求使用 Requirement Brief，记录用户场景、行为差异、范围、兼容策略和验收标准。
- Brief 按 [`verification-contract.md#micro-change`](./docs/verification-contract.md#micro-change)
  保存目标、计划/实际文件、测试点、执行主体和验证缺口。
- Micro Change 不生成正式 Spec，因此不触发最小 Spec 包落盘。
- Review 和 Verify 不得跳过，但只针对本任务拥有的语义 patch。
- `workflow:route` 会重新执行结构化事实分类；Micro Change 不接受只有 Route 名称的人工选择。
- Implement 起提交本地 JSON Brief，锁定 G / AC / OOS / C / VT 计划哈希；Review 起补充
  Actual Change，并与实际 patch 的仓库和文件清单逐项匹配。
- Locate 完成后先向用户展示原因/依据、修改点和验证项并结束回合；明确批准后 Implement
  Route 才接受 `--user-approved`，任何方案变化都使批准失效。
- 首次 Packet 生成匿名 Run ID。同 Route 后续阶段复用；切 Route 创建新 Run，并用
  `--parent-run-id` 关联原 Run，禁止一个 Run 跨 Route 混用。
- Locate 可选传 `--repository` 作为目标仓库提示；Implement 若传入则与 Brief 对齐；只有
  Review 起它才是必须与 HEAD 和 patch 共同校验的来源绑定参数。
- Review、Verify 和 Git Inspect 通过 `--micro-patch-file`（Windows 首选）或 stdin 提交
  任务专属 unified diff，复核实际仓库、文件数和语义行数。
- 数量阈值只在 `routes.json.microChangeGate` 维护；Review 起先用只读 reverse apply 检查
  证明 patch 对应仓库当前内容，再把仓库、HEAD 和 patch 合成为匿名来源哈希；运行日志绑定
  阶段顺序和该来源哈希，后续阶段不得更换实际补丁或基线。旧 Review 事件缺少来源哈希时，
  下一阶段先按当前仓库重新校验并建立绑定。
- 用户要求落盘、跨会话、异步交付、Portable 状态或独立审查时，不使用 Micro Change。

括号中的 `lite`、`mini`、`S` 和 `gaps-only` 是阶段配置，不是新的阶段：

- `Intake (lite)`：保留目标、范围、验收、待确认问题和仓库上下文，其余无信息小节可省略。
- `Spec (S)`：使用 [`03-spec.md`](./docs/03-spec.md) 的 S 级深度。
- `Plan (mini)`：使用 [`04-plan.md`](./docs/04-plan.md) 的完成条件和验证项，可与 S 级 Spec 合并表达。
- `Verify (gaps-only)`：只记录评审中能够确认的验证证据、缺口和建议人工验证，不声称执行运行态验证。

完整开发流程为：

```text
Source Capture -> Intake -> PRD -> Spec -> Plan -> Implement -> Review -> Verify -> Git Inspect
```

任务路由中实际进入的每个阶段都必须产出可审查内容：

| 阶段 | 产物 | 说明 |
|------|------|------|
| Source Capture | Source Snapshot | 从本地需求池/缺陷池读取可追踪原始记录 |
| Intake | 需求/缺陷卡片 | 把原始输入整理成结构化事实 |
| [Analyze](./docs/analyze.md) | Analysis Report | 只读分析事实、证据、结论和未确认项 |
| PRD | 产品需求文档 | 明确目标、范围、交互、验收 |
| Spec | 技术实现说明 + Goal & Verification Contract | 明确目标、文件、数据流、接口、风险和验证矩阵 |
| Plan | 任务计划 | 拆成可执行、可检查的步骤 |
| Implement | 代码变更 | 最小化实现，不改无关代码 |
| Review | 审查报告 | 独立检查逻辑、规范、风险 |
| Verify | 验证记录 | 记录已验证和未验证内容 |
| Git | Git Report | 仓库上下文、status/diff，以及已获授权的 commit/push 结果 |

任务产物默认保留在当前对话中。标准流程业务任务生成正式 Spec 时，按 [`03-spec.md`](./docs/03-spec.md)
自动保存最小 Spec 包和 `verification.json` 到 `.agent-workflow/tasks/local/<task-id>/`；Micro Change
不生成正式 Spec，也不创建任务目录。其他产物只有在用户要求完整落盘、可追溯记录或异步交付时，
才按 [`12-artifacts.md`](./docs/12-artifacts.md) 保存。

## 三种执行模式

同一套流程可以运行在三种模式下：

| 模式 | 适用场景 | 要求 |
|------|----------|------|
| Pair Mode | 复杂需求、UI 对齐、需求不清 | 人和 Agent 高频交互，关键阶段确认 |
| Async Mode | 独立 issue、明确缺陷、文档或测试 | Agent 可异步执行，但必须产出 PR/Review/Verify 记录 |
| Runtime Mode | 有 MCP、hooks、subagent、CI 的环境 | 用工具增强流程，但不得绕过阶段门禁 |

默认优先 Pair Mode。只有需求明确、影响范围可控、验证方式清楚时，才使用 Async Mode。

## 两种任务状态模式

执行模式与任务状态模式相互独立：

| 状态模式 | 适用场景 | 保存方式 |
|----------|----------|----------|
| Conversation | 单一工具内完成、无需长期追踪 | 阶段产物保留在当前对话；标准流程生成正式 Spec 时自动保存最小 Spec 包，Micro Change 不落盘 |
| Portable | 可能切换 Agent、异步执行、跨会话或长期交接 | 按 [`12-artifacts.md`](./docs/12-artifacts.md) 保存 `manifest.md` 和必要阶段产物 |

用户明确提出“可能换工具”“需要交接”“异步执行”或“保存过程”时，即视为授权创建对应任务产物，但不自动授权 stage、commit、push 或创建 PR。

## 自动接入与备用启动

项目初始化由公开 CLI 的 `init` 命令管理。它生成 Host Config、继承式项目 Profile、目录、
`.gitignore` 本地状态区块、根 `AGENTS.md` 启动区块和完整 npm scripts；已有项目文件只增补受管区块，
配置文件存在时保留原文，script 冲突时停止并要求人工处理。`setup` 随后只管理工具薄入口。
CLI 基于 Node.js，可在 Windows、macOS 和 Linux 运行；`src/` 是包内实现，不属于项目集成契约。

```sh
# 首次初始化；之后可在 CI 中检查漂移
npm exec --no -- agent-workflow init
npm run workflow:init:check

# 自动检测仓库中正在使用的 Agent 配置
npm run workflow:setup

# 预览全部支持项，不写文件
npm exec --no -- agent-workflow setup --agent all --dry-run

# 检查入口是否有效
npm run workflow:setup:check
```

Codex、Qoder 和支持 `AGENTS.md` 的 TRAE 版本直接复用根目录入口。Claude Code、GitHub Copilot 和 Cursor 使用各自的薄入口。工具没有自动发现能力时，运行 `agent-workflow setup --agent generic` 获取与当前安装位置一致的启动提示；不要手工猜测包路径。

项目 Profile 可通过 `extends: "workflow:resources/profiles/default/profile.json"` 只声明差异；
对象递归合并，数组整体替换，继承环和越界路径会被拒绝。可复制且参与契约回归的完整宿主见
[`examples/generic-host/`](./examples/generic-host/README.md)。

启动后运行 `workflow:route` 并输出紧凑 Route Packet；阶段切换时重新生成，一次只加载当前阶段卡。默认使用 `--materialize` 在 4000 字符工具输出上限内合并阶段卡和选中 Skill；深度文档通过 `--reference <path#heading>` 只选当前阶段白名单章节。完整结果超限时按阶段卡、Skill、Reference 的顺序物化可完整容纳的文档，并明确列出剩余项；不截断单份文档。只有首份阶段文档仍无法容纳时才回退为普通 Packet。

### 运行路由表

下表由 `agent-workflow/resources/routes.json` 生成。修改路由后运行
`npm run workflow:routes:docs -- --write` 更新；`quality:policy` 会检查漂移。

<!-- ai-workflow:routes:start -->
| Route | Entry | Runtime Stages |
|---|---|---|
| `pool-capture` | `pool` | `capture` → `report` |
| `micro-change` | `direct`, `pool` | `defect`: `locate-defect` → `implement` → `review-defect` → `verify-defect` → `git-inspect`<br>`requirement`: `locate-requirement` → `implement` → `review-requirement` → `verify-requirement` → `git-inspect` |
| `standard-change` | `direct`, `pool` | `capture` → `intake` → `prd` → `spec-plan` → `implement` → `review` → `verify` → `git-inspect` |
| `analysis` | `direct`, `pool` | `capture` → `analyze` |
| `review-only` | `direct`, `pool` | `capture` → `review` → `verify` |
| `workflow-maintenance` | `not-applicable` | `inspect` → `implement` → `review` → `verify` → `git-inspect` |
| `git-only` | `not-applicable` | `inspect` → `action` → `report` |
| `portable-resume` | `direct`, `pool`, `not-applicable` | `resume` |
<!-- ai-workflow:routes:end -->

## 运行反馈与经验晋升

`workflow:route` 默认写入匿名化本地 JSONL，只包含 Route、Stage、Entry、Skill 名称、风险标识、预算、耗时、结果、错误码，以及 Micro 的仓库、patch 和来源绑定匿名哈希。不得记录用户原文、需求或缺陷正文、文件内容、命令参数和凭据。

```text
npm run workflow:feedback -- --days 7
npm run workflow:feedback -- --days 30 --include-legacy
npm run workflow:retention
```

反馈默认只聚合当前 `routesVersion`；`--include-legacy` 仅用于迁移历史对比。摘要同时报告关联
Run 数和未关联事件数，但不返回逐条事件。用户要求“生成候选知识”时，Agent 应基于当前任务沉淀、diff、评审和验证结果直接生成完整候选，并检索已有知识避免重复；`workflow:knowledge -- lint` 用于批准前检查。用户明确确认当前唯一候选无误后，执行 `workflow:knowledge -- approve` 自动记录会话用户确认并晋升。正式知识仍不会自动加入运行上下文，必须链接到对应 Skill、阶段卡或深度 Reference。

阶段转换和任务结果使用匿名枚举事件记录；需要显式记录路由修正、风险追加、人工覆盖或验证缺口时使用 `workflow:event`，并传入 Packet 的 `--run-id`。保留策略见
[`retention-policy.md`](./docs/retention-policy.md)；当前只报告陈旧和归档候选，不自动删除。

## 质量门禁

项目和 CI 只调用公开 CLI；确定性检查的内部实现位于 `src/validators/`：

```text
agent-workflow quality:js --staged
agent-workflow quality:js --file <path>
agent-workflow quality:js --patch-stdin --label <path>
agent-workflow quality:staged
agent-workflow quality:skills
agent-workflow quality:workflow
agent-workflow quality:tasks
agent-workflow cli:test
agent-workflow execution:writable:test
agent-workflow context
agent-workflow routes:eval
agent-workflow routes:prompt-eval --check-suite
agent-workflow routes:prompt-eval --emit
agent-workflow routes:prompt-eval --predictions-stdin
agent-workflow route --list
agent-workflow routes:docs --check
agent-workflow routes:test
agent-workflow verify:ci --all
agent-workflow verify:contract --all
agent-workflow feedback --days 7
agent-workflow quality:policy
```

- Agent 写后 Hook 与 Git Hook 调用相同的 Node.js 脚本，不维护工具专属检查副本。
- `route-eval.ts` 只验证结构化 facts 到 Route 的确定性映射。`fact-extraction-eval.ts`
  发出只含自然语言 prompt 和哈希的挑战集，并校验外部 Agent 返回的 facts 是否与金标准完全一致；
  两层结果不得混称为“语义分类已通过”。
  预测输入格式为 `{"version":1,"cases":[{"id":"...","promptHash":"...","facts":{}}]}`，
  不得把金标准 facts 放入发给提取器的挑战集。
- 版本化 Git Hook 模板位于 `resources/hooks/`；宿主仓库由用户运行 `npm run quality:hooks:setup` 安装到 `.githooks/` 并接入，独立子仓库使用 `npm run quality:hooks:setup -- --repository <repository-path>`，把 `setup` 换为 `check` 可同时核对 Git 配置与模板漂移。
- `quality:policy` 是完整工作流政策检查；GitHub Actions 在 Node.js 20/22/24 上执行类型检查和政策门禁。
- 业务仓库或隔离 CI 按 [`ci-verification.md`](./docs/ci-verification.md) 产出结构化结果；`quality:policy` 校验其 Schema 和内部一致性，不代替业务测试本身。
- 事件解绑、定时器清理等需要上下文判断的问题只发出警告，并进入 Active Profile 声明的 Review Skill。
- 本地 Hook 只提供快速反馈；完成工作流维护后仍需显式运行 `quality:policy`。
- 独立 Git 仓库分别接入 Hook、检查 status 和生成 diff，不能假设顶层 Hook 自动覆盖子仓库。
- 新生成的 `.agent-workflow/tasks/local/`、运行日志、Micro Brief / patch 和工具本机配置由 `.gitignore` 保留在本地，不进入治理仓库历史。
- 构建和测试是否可由 Agent 执行以根约束和 Active Profile 为准；未运行项必须进入 Verify Gap。
- Micro Change 优先使用 `--file` 做目标文件检查；该模式会对比原始 diff 与忽略行尾后的语义 diff，阻止换行符或格式污染把微变更放大为整文件改写。目标文件已有其他语义改动时，使用修改前快照生成任务专属 patch，经 `check-js-diff --patch-file` 检查代码规则，再用 `workflow:route --micro-patch-file` 检查实际 Micro Gate。Windows 让 Git 通过 `diff --output=<file>` 直接写入 `.agent-workflow/runtime/patches/`，不使用 PowerShell 管道。该 patch 必须能对仓库当前内容通过 `git apply --reverse --check`，否则不能证明来源并升级标准流程。

## 分层

| 层级 | 路径 | 职责 |
|------|------|------|
| Package API | `agent-workflow` CLI（编译入口 `dist/bin/agent-workflow.js`） | 对项目和 CI 提供稳定命令，隐藏内部模块路径 |
| Bootstrap | `agent-workflow/docs/START.md`、`agent-workflow/docs/ROUTER.md` | 薄启动、首次分流和紧凑回执 |
| Workflow Core | `agent-workflow/src/core/` | 通用路由、阶段、状态、反馈和评测 |
| Configuration | `agent-workflow/src/config/`、`.agent-workflow/config.json` | 解析包资源与宿主项目路径，不反向依赖具体项目 |
| Runtime Resources | `agent-workflow/resources/routes.json`、`agent-workflow/resources/cards/` | 当前阶段白名单、预算和短卡 |
| Quality Gates | `agent-workflow/src/validators/` | Agent Hook、Git Hook 和 CI 共用的确定性检查 |
| Contract Tests | `agent-workflow/tests/contract/` | 通用内核、CLI、配置和状态契约回归 |
| Default Profile | `agent-workflow/resources/profiles/default/` | 可移植的中立默认配置与评测用例 |
| Project Profile | `.agent-workflow/profile/` | 项目词汇、策略、Skill 映射、评测和知识 |
| Runtime Feedback | `.agent-workflow/runtime/logs/` | 匿名化 Route/Skill 指标；不进入启动上下文 |
| Security Policy | `agent-workflow/resources/policies/security-policy.json`、`agent-workflow/docs/security-boundaries.md` | 不可信内容、工具分级、审批与执行预算 |
| Knowledge Staging | `.agent-workflow/profile/knowledge/` | 经验候选、人工晋升和审计记录 |
| Deep Reference | `agent-workflow/docs/`、`.agent-workflow/profile/policy.md` | 人类维护和按需加载的通用/项目事实源 |
| Adapter Contract | `agent-workflow/resources/adapters/README.md` | 所有工具适配器必须遵守的边界 |
| Tool Adapters | `agent-workflow/resources/adapters/<tool>.md` | 启动、能力映射和降级 |
| Task State | `.agent-workflow/tasks/local/<task-id>/` | 标准流程 Conversation 的最小 Spec 包，以及 Portable 的完整阶段状态和交接记录 |

MCP、subagent、hooks、自动同步和自动提交都属于可选增强能力；缺少这些能力时，核心流程仍然必须可执行。

需要把外部 MCP 的需求或缺陷查询接入 `source-provider` 时，使用正式内置模块
[`@gk0919/agent-workflow/plugins/mcp-source-provider`](./docs/MCP-SOURCE-PROVIDER.md)。该模块通过公开 Plugin 契约和
`source:capture` 命令工作；命令默认按 Active Profile 的 Source Provider 绑定选择 Plugin，
具体编号和工具映射仍留在宿主插件配置中，不把业务接口或凭据写入 Core。

依赖方向、公开 API 和状态边界见 [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md)；通用内核、Active Profile 和新项目接入方式见 [`PORTABILITY.md`](./docs/PORTABILITY.md)。项目词汇、Source Provider、Review Skill、Issue 规则和治理路径不得写回 Core。

## 已定义适配器

| 工具 | 适配文件 |
|------|----------|
| Codex | [`adapters/codex.md`](./resources/adapters/codex.md) |
| Qoder | [`adapters/qoder.md`](./resources/adapters/qoder.md) |
| TRAE | [`adapters/trae.md`](./resources/adapters/trae.md) |
| Claude Code | [`adapters/claude-code.md`](./resources/adapters/claude-code.md) |
| Cursor | [`adapters/cursor.md`](./resources/adapters/cursor.md) |
| GitHub Copilot | [`adapters/github-copilot.md`](./resources/adapters/github-copilot.md) |
| 其他工具 | [`adapters/generic-agent.md`](./resources/adapters/generic-agent.md) |

## 参考方法

本工作流吸收了几类主流实践：

- Spec-driven development：需求、设计、任务分离，验收标准可测试。
- Repository instructions / steering：把规则当作代码维护，而不是临时提示词。
- Cloud agent：issue 到 patch 或已授权 draft PR 的异步闭环，但必须保留人工 review。
- Subagent：复杂任务拆给独立上下文执行者，减少实现者自审盲区。
- Hooks：在写文件后、提交前、push 前触发检查。
- MCP / tool gateway：按需读取上下文并受控调用外部系统。
