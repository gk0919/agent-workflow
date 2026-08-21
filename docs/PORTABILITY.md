# Portable Agent Workflow

本页定义工作流从单一项目剥离后的稳定边界。通用规则只存在于 Workflow Core；项目词汇、来源、审查工具和治理路径只存在于 Active Profile。

## 通用执行流

```text
Bootstrap
  -> classify intent and source
  -> choose read-only / quick change / standard change / high-risk change
  -> capture facts and acceptance
  -> design and approval
  -> implement
  -> review
  -> verify
  -> git inspect
  -> close, feedback and optional knowledge staging
```

只读任务跳过设计和实现。Quick Change 使用对话内 Brief；Standard Change 使用可追踪 Spec；高风险任务在 Standard Change 基础上增加人工确认、独立审查或发布协同。

## 分层

| 层 | 事实源 | 可否项目定制 |
|---|---|---|
| Host Config | `.agent-workflow/config.json` | 只选择 Profile 和 Skill、任务、知识、运行时路径 |
| Core | `src/`、`docs/`、`resources/routes.json` | 不写项目业务规则 |
| Profile | `.agent-workflow/profile/` | 定义词汇、Provider、Skill、Issue、评测和治理路径 |
| Domain Skills | `.agents/skills/` | 定义领域规则和工具流程 |
| Task State | `.agent-workflow/tasks/local/`、`shared/` | 隔离本地任务和可提交协作任务 |
| Runtime | `.agent-workflow/runtime/` | 保存匿名事件和临时状态，始终忽略提交 |
| Adapter | `resources/adapters/`、`src/adapters/` | 只映射工具能力与降级路径 |

## Profile 契约

Active Profile 必须声明：

- 任务 intent、change type、Entry 和阶段词汇；
- Source Provider 绑定；
- 默认 Review Skill；
- Issue 追踪格式和是否强制；
- 项目治理必需路径、Markdown 扫描范围和废弃引用；
- setup 阶段必须存在的项目资源。

Core 不得直接引用项目 Skill 名、Issue 前缀、产品规范路径或仓库目录结构。Profile 不得覆盖安全优先级、用户授权、阶段门禁或运行时数据最小化规则。

项目 Profile 推荐通过 `extends: "workflow:resources/profiles/default/profile.json"` 继承中立默认值，
只声明项目差异。对象递归合并，数组整体替换；路径仍以工作区根或 `workflow:` 包根解析。
继承链最多八层，并拒绝循环、不安全字段和越出工作区/工作流包的路径。

## 接入新项目

1. 通过 `@gk0919/agent-workflow` 的 Actions `.tgz`、GitHub Packages 或 monorepo workspace 固定版本；不要手工复制 `src/`。
2. 在宿主根目录运行 `npm exec --no -- agent-workflow init`，生成配置、Profile 覆盖层、目录、根入口、忽略规则和 npm scripts。
3. 将项目策略、评测和知识分别放入 `profile/policy.md`、`profile/evals/` 和 `profile/knowledge/`；从根约束或命中 Skill 显式链接需要加载的项目策略。
4. 将项目硬约束保留在根 `AGENTS.md`，领域规则保留在 `.agents/skills/`；不要复制进 Adapter 或 Core。
5. 运行 `npm run workflow:setup`，再运行 `npm run workflow:init:check`、`npm run workflow:profile`、`npm run workflow:context` 和 `npm run quality:policy`。
6. 在至少一个非来源项目中验证无需修改 Core 即可完成路由、修改、Review 和 Verify；完整基线见 [`generic-host`](../examples/generic-host/README.md)。

本地迁移验证可临时设置 `AI_WORKFLOW_PROFILE=workflow:resources/profiles/default/profile.json`；它只覆盖本次进程的 Active Profile，不改写宿主配置。项目和 CI 只能调用 `agent-workflow` CLI；`src/` 路径不是兼容契约。

历史项目的词汇、Issue 格式、Provider 和 Skill 绑定保留在各自项目 Profile；本通用包不维护业务兼容分支。Profile 覆盖只改变项目绑定，不改变通用状态机和 Route ID。
