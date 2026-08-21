# Verify

Verify 的目标是记录真实验证情况，而不是只写“已测试”。

## 输出模板

```md
# Verify Report

## Contract Summary
- Contract Status:
- Covered Goals / Acceptance:
- Actual Changes:

## Verification Results
| Bucket | VT | AC | Status | Evidence / Gap |
|--------|----|----|--------|----------------|
| static / mcp-playwright / mcp-other / ci / manual / not-verifiable | | | | |

## Commands
- Actually Run:
- Suggested for Human / CI:

## 结论
通过 / 有条件通过 / 不通过
```

## 验证规则

- 命令服从项目规则和用户授权；项目禁止 Agent 运行构建或测试时，只列入人工 / CI 建议。
- 只记录实际执行结果，不得把建议命令写成已验证。
- 每项结果保留 VT 和 AC；未在契约中的临时检查先补 Test Point，再记录结果。
- 人工步骤写清入口和预期，并覆盖适用业务场景。
- 隔离 CI 按 `ci-verification.md` 校验任务、仓库和 commitSha；失败或 partial 进入缺口。
- MCP / Playwright 执行前分别确认 capability available、authorized 和 environment ready；
  任一不是 `yes` 时记录 blocked，不得把工具存在写成已验证。
- 状态按 [`verification-contract.md`](./verification-contract.md) 收口。

## Gaps-only 配置

`Verify (gaps-only)` 只记录现有证据，其余列为缺口；Review 通过不代表运行验证通过。

## Targeted 配置

`Verify (targeted)` 用于 Micro Change：

- 只验证任务 patch 和目标文件，不用全仓库噪声代替证据。
- JavaScript 至少执行语法检查和 `agent-workflow quality:js --file <path>`；目标文件已有其他语义改动时使用任务专属 patch 的 `--patch-stdin` 模式。
- `defect` 覆盖原问题、边界与回归点；`requirement` 逐项覆盖 1～3 条 AC 及适用兼容场景。
- 准确区分未复现、未运行、通过和不适用。
- 发现 Gate 范围外行为时升级标准 Verify。

## 通过标准

- 已区分静态、MCP / Playwright、CI、人工和无法验证五类结果。
- Actual Change 与任务 patch 一致，每个 AC 至少有一个 VT；`verified` 时每个 AC 至少有一个 passed VT。
- 已区分实际结果、建议动作和未验证项。
- 阻塞性问题不进入 Git 阶段。
- 引用的 CI 结果已经通过 `workflow:verify:ci` 校验，且与目标代码状态一致；没有 CI 结果时明确标记。
