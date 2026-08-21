# Runtime Enhancements

本文件定义 MCP、subagent、hooks、cloud agent 等增强能力的使用边界。增强能力可以提高效率，但不能替代 `agent-workflow/` 的阶段产物和门禁。

开始任务时先按 [`adapters/README.md`](../resources/adapters/README.md) 检查当前会话真实具备的能力。不得因为某个产品通常支持某项能力，就假设本次会话已经配置或授权。

## 能力分层

| 能力 | 价值 | 边界 |
|------|------|------|
| MCP / Tool Gateway | 按需检索上下文、受控调用外部系统 | 不能绕过用户权限和项目规则 |
| Subagent | 独立上下文处理定位、review、测试 | 必须汇总产物，不能只给结论 |
| Hooks | 写后、提交前、push 前自动检查 | 失败必须阻断或明确记录 |
| Cloud Agent | issue 到 patch 或已授权的 draft PR | 适合明确任务，不适合需求不清 |
| Memory / Knowledge | 沉淀高频经验 | 必须可审查、可删除、可版本化 |
| Git Worktree | 按任务隔离并行修改和用户已有改动 | 按独立仓库绑定，Git 写动作分别授权 |

## 可移植性底线

无论 Runtime 能力如何变化，都必须保证：

- 需求、计划、Review 和 Verify 能以 Markdown 表达。
- 缺少 subagent 时可以串行完成相同阶段。
- 缺少 hooks 时可以按门禁清单手工检查。
- 缺少 MCP 时按项目策略使用受控降级路径，不能伪造读取结果。
- 缺少文件编辑能力时可以输出 patch。
- Portable 任务能由另一工具读取 `manifest.md` 后继续。
- stage、commit、push、PR 等授权不随工具切换继承，除非任务产物中有明确、仍适用的用户授权记录。

## Worktree 运行协议

Worktree 是可选隔离能力，不改变 Router、任务阶段或业务修改授权。选择使用时：

1. 定位阶段先确认稳定仓库根和目标文件，再运行 `workflow:worktree plan`。
2. `create`、`branch`、`remove` 分别确认授权；默认 detached，不把创建隔离目录等同于创建分支。
3. Active Profile 声明的每个独立仓库分别绑定；代码、diff 和 Git Inspect 都在绑定路径执行。
4. 任务完成只提示清理；禁止生命周期命令隐式 stash、prune、force remove 或删除分支。

本机绑定保存在已忽略的 `runtime/worktrees/`，Portable 任务只保留逻辑仓库、基线 commit、
checkout mode 和分支等稳定事实。另一台机器恢复时重新定位或创建，不继承旧绝对路径。

## MCP 使用协议

支持 MCP 时，按以下顺序使用：

1. `search`：检索规则、文档、技能、知识。
2. `get_*`：读取最小必要正文。
3. `tool`：调用外部系统，例如需求、缺陷、菜单、CI。
4. `log`：记录调用结果和失败原因。

不得用临时脚本绕过已有 MCP 工具，除非工具缺失且用户同意。

MCP 结果如果是完成任务所必需的事实，应在任务产物中保存最小必要摘要、来源和读取时间。不得保存令牌、Cookie、签名 URL 或请求头。

Provider Entry 缺少首选能力时，必须按 Active Profile 或对应 Provider Skill 使用受控只读降级；没有声明降级时停在 `blocked-at-entry`。Direct Entry 直接保存用户原文，不调用 Provider 补全；两种入口都必须形成 Source Snapshot。

## Subagent 分工

推荐角色：

| 角色 | 职责 | 产物 |
|------|------|------|
| locator | 定位文件和影响范围 | 文件清单、入口、依赖 |
| planner | 拆任务和风险 | Task Plan |
| implementer | 执行最小改动 | Change Summary |
| reviewer | 独立审查 | Review Report |
| verifier | 跑测试和手工验证 | Verify Report |
| git | Git Inspect 和已授权的 commit/push | Git Report |

没有 subagent 时，由当前执行者串行完成这些职责。

subagent 的内部消息不是交接产物。主执行者必须把结论、证据和未完成事项汇总到对应阶段文件。

## Hooks 建议

| Hook | 触发点 | 检查 |
|------|--------|------|
| User Prompt Submitted | 用户输入后 | 识别任务类型和是否需要 Intake |
| Pre Tool Use | 执行工具前 | 权限、危险操作、是否需要确认 |
| Post Tool Use | 写文件后 | UI 规范、lint、review checklist |
| Pre Commit | commit 前 | status、diff、项目允许的检查、未验证项 |
| Pre Push | push 前 | 分支、远端、CI、用户授权 |

共享确定性检查位于包内 `src/validators/`。`resources/hooks/` 的版本化模板安装到宿主 `.githooks/` 后只调用公开 CLI，不复制检查逻辑。Git Hook 可被 `--no-verify` 绕过，因此完成工作流维护后仍需显式运行 `quality:policy`。

## Async / Cloud Agent

适合：

- 需求明确的独立缺陷。
- 文档更新。
- 测试补充。
- 低耦合的小功能。

不适合：

- 截图依赖强的 UI 缺陷。
- 需求未澄清的复杂功能。
- 跨多个业务模块的大改造。
- 需要实时业务判断或敏感权限的任务。

Async 任务必须以 patch 或完整报告结束，并请求人工 review。只有任务已明确授权创建 PR 时，才可以 draft PR 结束；PR 授权不包含合并。

## 经验沉淀

沉淀链路：

```text
真实任务 -> 候选经验 -> 人工审查 -> 正式规则/知识 -> 后续检索命中
```

禁止把完整聊天记录、临时猜测或一次性决策直接写成长期规则。
