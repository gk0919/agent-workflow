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
frontmatter 声明 `contract_version: 1`。结构遵守
[`verification-contract.schema.json`](../resources/schemas/verification-contract.schema.json)，
示例见 [`verification-contract.sample.json`](../resources/examples/verification-contract.sample.json)。

生命周期：

1. Spec / Plan：写入 Goals、Acceptance Criteria、Out of Scope、Planned Changes 和 Test Points，
   `contractStatus` 为 `planned`。
2. Implement：根据实际任务 patch 写入 Actual Changes；实施完成后改为 `implemented`。
3. Review：核对实际文件、目标映射、范围扩大和错误验证声明。
4. Verify：逐项更新 VT 状态和证据；全部满足时为 `verified`，仍有缺口时为 `conditional`。

`routes.json.verificationContract.requiredForSpecsCreatedOnOrAfter` 是启用时间的唯一事实源。
此前创建且没有 `contract_version` 的历史任务继续按旧格式读取；此后新 Spec 必须声明版本
并创建契约。一旦声明版本或创建 `verification.json`，两者必须成对存在并通过确定性校验。

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

## Micro Change

Micro Change 不创建任务目录；机器可校验的 Change Brief 使用
[`micro-change-brief.sample.json`](../resources/examples/micro-change-brief.sample.json) 作为唯一
字段模板，工作副本放在忽略目录 `.agent-workflow/runtime/briefs/`。契约必须保持
`G -> AC -> C` 和 `AC -> VT` 全覆盖；ID、允许字段、Method / Executor 组合和状态枚举由
`micro-brief.ts` 确定性校验。

Implement 锁定 Goal、AC、OOS、Planned Change 和 VT 计划；Focused Review 起填写
Actual Change，并要求 Repository / File 与实际 patch 完全一致；Git Inspect 前所有 VT
必须离开 `planned` 且填写 Evidence / Gap。同一 Run 的计划哈希不得漂移，执行状态与证据可随
阶段更新。若目标、文件、测试点或验证主体无法明确，或者需要持久化契约，升级 Standard Change。
