# CI Verification Result Protocol

业务构建和测试继续由用户或隔离 CI 执行，Agent 本地禁令不变。CI 使用
[`ci-verification.schema.json`](../resources/schemas/ci-verification.schema.json)
输出结构化结果；示例见
[`ci-verification.sample.json`](../resources/examples/ci-verification.sample.json)。

## 产出位置

与任务绑定时保存为：

```text
.agent-workflow/tasks/local/<task-id>/ci-verification.json
```

临时或外部 CI 也可把结果保存到工作区相对路径，并执行：

```text
npm run workflow:verify:ci -- --file <relative-path>
```

`quality:policy` 会校验示例以及任务目录中已经存在的所有结果。

## 语义

- `repository.root` 必须使用工作区相对路径。
- `commitSha` 标识 CI 实际验证的代码状态；Verify 阶段必须再与目标仓库当前提交核对。
- `environment.isolated` 必须为 `true`。
- `checks` 只记录检查 ID、类型、状态和短摘要，不保存完整命令、原始日志或凭据。
- 任一检查失败时 `overallStatus` 必须为 `failed`。
- 有 skipped 且无失败时 `overallStatus` 必须为 `partial`。
- 全部检查通过时才允许 `overallStatus: passed`。

## Verify 使用

通过 Schema 校验只代表“结果格式和内部一致性可信”，不自动证明：

- CI 对应当前工作区或当前分支。
- 真实业务环境、权限、旧数据或 UI 已验证。
- 未运行的检查已经通过。

Verify Report 应分别记录本地静态证据、CI 证据、人工业务验证和剩余缺口。
