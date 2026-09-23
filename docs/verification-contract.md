# Goal and Verification Contract

本文件是目标、改动范围、测试点、执行主体和验证证据的唯一结构化事实源。它不新增流程阶段，
而是在 Spec / Plan 建立，在 Implement 更新，在 Review 核对，在 Verify 收口。

## 核心追踪链

```text
Goal (G)
-> Acceptance Criterion (AC)
-> Planned Change (C)
-> Actual Change (A)
-> Verification Test Point (VT)
-> Evidence / Gap
```

- 每个 Goal 至少有一个 AC。
- 每个 AC 至少映射一个 Planned Change 和一个 VT。
- Actual Change 必须来自任务专属 diff，不能用计划清单冒充。
- `passed` / `failed` 必须有证据；`blocked` / `not-applicable` 必须有原因。
- 未运行的命令、MCP、浏览器或人工场景不得写成已通过。

## 标准流程

正式 Spec 创建 `.agent-workflow/tasks/local/<task-id>/verification.json`，并在 `spec.md`
frontmatter 声明 `contract_version`。当前要求为版本 2，结构遵守
[`verification-contract-v2.schema.json`](../resources/schemas/verification-contract-v2.schema.json)；
历史任务保留版本 1，结构遵守
[`verification-contract.schema.json`](../resources/schemas/verification-contract.schema.json)，
示例见 [`verification-contract.sample.json`](../resources/examples/verification-contract.sample.json)。
`spec.md` 的 `contract_version` 必须与 `verification.json` 的 `schemaVersion` 一致。

生命周期：

1. Spec / Plan：写入 Goals、Acceptance Criteria、Out of Scope、Planned Changes 和 Test Points，
   `contractStatus` 为 `planned`。
2. Implement：根据实际任务 patch 写入 Actual Changes；实施完成后改为 `implemented`。
3. Review：核对实际文件、目标映射、范围扩大和错误验证声明。
4. Verify：逐项更新 VT 状态和证据；全部满足时为 `verified`，仍有缺口时为 `conditional`。

`routes.json.verificationContract` 是启用时间的唯一事实源：`version` 为当前要求的契约版本；
`requiredForSpecsCreatedOnOrAfter` 之后创建的 Spec 必须创建契约；
`executionBaselineRequiredForSpecsCreatedOnOrAfter` 之后创建的 Spec 必须声明
`contract_version: 2`。此前创建的历史任务继续按旧版本读取；一旦声明版本或创建
`verification.json`，两者必须成对存在并通过确定性校验。

### 执行基线（版本 2）

版本 2 在版本 1 之上只增加 `testPoints[].executedAgainst`：`status` 为 `passed` 或 `failed`
时必需，其他状态必须省略。字段为：

- `executedAt`：毫秒精度的 UTC 执行时间。
- `repositories`：1–100 个执行基线仓库，每项含 `repository`、`root`、`head`、`fingerprint`。
- `definitionHash`：本次执行所依据的 G / AC / OOS / C 与该校验点定义的哈希。
- `environment`：环境说明。

持久任务由 CLI 记录基线，不手工填写 `executedAgainst`：

```text
agent-workflow task verify-begin --task <task-id> --test <VT-id> \
  --evidence <task-relative-file>#<section> --environment <description> \
  --reason <reason> --expected-revision <revision>
agent-workflow task verify-record --task <task-id> --test <VT-id> --status passed \
  --evidence <task-relative-file>#<section> --reason <reason> \
  --expected-revision <revision>
```

`verify-begin` 必须在执行测试前登记，并要求证据文件在登记后新建，不能复用历史输出；
`verify-record` 只在仓库基线、验证定义与登记时一致时接受 `passed` / `failed`。
`blocked` / `not-applicable` 会清除未收口的开始记录。

`task status` 按 `current` / `stale` / `unknown` 报告新鲜度：缺少基线、契约仍为版本 1、
验证定义变化或仓库无法判定时都是 `unknown`。持久任务的 Verify 与最终完成要求所有
`passed` 点均为 `current`；代码变化后重新验证，或经有依据的适用性评估后重新登记基线。
重新保存检查点只更新观察基线，不能把旧的 `passed` 绑定到新代码上，也不清除 `stale`。

仍为版本 1 的历史任务继续可读，其已通过结论按 `unknown` 读取。升级为持久任务前先升级
契约版本并重新记录证据；`verify-begin` 与完成门禁会给出可操作的版本错误，不允许沿用
没有执行基线的旧结论。

CI 证据沿用现有公开契约，通过证据文件哈希、`check ID` 和 `commitSha` 引用。`HEAD` 一致但
工作树有未提交改动时，不能把 CI 结果当作当前改动已通过。

### 验证方式

`method` 使用以下枚举：

| Method | 用途 |
|---|---|
| `static` | diff、语法、Schema、链接和确定性规则 |
| `mcp-playwright` | 页面交互、DOM、网络、控制台和截图 |
| `mcp-other` | 其他受控 MCP / Connector 验证 |
| `cli` | 项目明确允许执行的本地命令 |
| `ci` | 隔离 CI 的构建、测试和 smoke 结果 |
| `manual` | 业务语义、视觉、真实权限或真实数据人工验收 |
| `not-verifiable` | 当前环境无法验证且必须说明原因 |

`executor` 使用 `agent`、`human` 或 `ci`。`manual` 必须由 `human` 执行，`ci`
必须由 `ci` 执行；MCP 由 `agent` 执行。

MCP Test Point 还必须记录：

- `available`：当前会话是否真实提供该能力；
- `authorized`：当前操作和目标是否已获授权；
- `environmentReady`：页面、登录态、权限和测试数据是否就绪。

三项都为 `yes` 才能把 MCP 结果标记为 `passed` 或 `failed`。工具存在不等于环境可验证；
会产生真实业务写入时仍按外部写入或高风险规则单独确认。

### Verify 输出

Verify Report 按契约生成以下结果桶：

1. Agent 已静态验证；
2. Agent 已通过 MCP / Playwright 验证；
3. CI 验证；
4. 必须人工验证；
5. 当前无法验证及原因。

每项保留 VT ID、对应 AC、状态和证据。最终结论不能高于未完成 Test Point 所允许的状态。

## level-1

level-1 不创建任务目录；机器可校验的 Change Brief 使用
[`brief.sample.json`](../resources/examples/brief.sample.json) 作为唯一
字段模板，工作副本放在忽略目录 `.agent-workflow/runtime/briefs/`。契约必须保持
`G -> AC -> C` 和 `AC -> VT` 全覆盖；ID、允许字段、Method / Executor 组合和状态枚举由
`micro-brief.ts` 确定性校验。

Implement 锁定 Goal、AC、OOS、Planned Change 和 VT 计划；Focused Review 起填写
Actual Change，并要求 Repository / File 与实际 patch 完全一致；Git Inspect 前所有 VT
必须离开 `planned` 且填写 Evidence / Gap。同一 Run 的计划哈希不得漂移，执行状态与证据可随
阶段更新。若目标、文件、测试点或验证主体无法明确，或者需要持久化契约，升级 level-2。
