# 架构契约

`agent-workflow` 是可版本化的通用工作流包，`.agent-workflow` 是宿主项目实例。二者必须保持单向依赖：包读取项目配置与状态，项目不得引用包内 `src/` 私有模块。

```text
AGENTS.md / Tool Bridge
          |
          v
agent-workflow CLI
          |
          v
Config Resolver -> Core -> Validators
       |            |
       v            v
Project Profile   Package Resources
       |
       v
Project Tasks / Runtime
```

## 公开契约

- `agent-workflow` 命令及其子命令是项目、Hook 和 CI 的唯一执行接口；TypeScript 源码编译到 `dist/` 后执行。
- `docs/START.md` 是 Agent 的唯一技术启动入口；`docs/ROUTER.md` 只负责首次分流。
- `resources/schemas/`、`resources/routes.json` 和 `resources/profiles/default/` 是版本化数据契约。
- `.agent-workflow/config.json` 是宿主项目的组合根，负责选择 Active Profile，以及 Skill、任务、知识和运行时路径。
- `workflow:` 定位符只解析到当前安装包内；普通相对路径只解析到宿主项目内。

`src/` 内文件名、模块边界和测试目录不是下游调用契约，可以在不改变 CLI、Schema 和数据语义的前提下重构。

## 依赖规则

1. `bin/` 只能分派公开命令，不承载业务规则。
2. `src/config/` 负责发现宿主项目并解析路径；Core 和 Validator 不自行猜测仓库根目录。
3. `src/core/` 只依赖配置层和通用资源，不包含项目名称、项目 Skill 或业务词汇。
4. `src/validators/` 可以验证 Core、资源和宿主组合结果，但不得写业务状态。
5. `src/plugins/` 只实现可复用的正式 Plugin，不包含项目 endpoint、Token 环境变量、编号格式或工具映射；宿主只能通过公开 package export 使用。
6. `examples/` 只展示生成结果，不是宿主依赖入口，也不得出现在 package export 中。
7. `resources/profiles/default/` 必须能脱离当前项目独立通过 Profile 与路由契约测试。
8. `.agent-workflow/profile/` 可以引用 `.agents/skills/` 和项目文档，但不得修改通用路由语义。

## 状态与版本

| 类型 | 位置 | 版本控制建议 |
|---|---|---|
| 通用代码、Schema、卡片、Adapter | `agent-workflow/` | 纳管并随包版本发布 |
| 项目配置与 Profile | `.agent-workflow/config.json`、`.agent-workflow/profile/` | 纳管，接受项目评审 |
| 共享任务模板或经批准的任务记录 | `.agent-workflow/tasks/shared/` | 按项目策略纳管 |
| 本机任务状态 | `.agent-workflow/tasks/local/` | 默认忽略 |
| 运行日志、临时 patch、缓存 | `.agent-workflow/runtime/` | 默认忽略，仅保留说明文件 |

通用包采用语义化版本：破坏 CLI、Schema 或持久化格式兼容性的修改提升主版本；向后兼容的命令、字段和能力提升次版本；内部修复提升补丁版本。读取旧配置时应提供安全默认值或明确迁移错误，不得静默改变含义。

## 扩展点

- 新项目：复制默认 Profile 到 `.agent-workflow/profile/`，再只覆盖项目词汇、Source Provider、Skill、治理路径和评测。
- 新工具：增加 `resources/adapters/<tool>.md` 和工具目标映射；不得复制 Core 规则。
- 新规则：通用阶段规则放 Core/卡片，项目规范放项目 Skill，机械检查放 Validator。
- 新持久化格式：先更新 Schema、迁移说明和契约测试，再开放 CLI 行为。

## 多 Agent 执行层

Route、Task、Plugin、Worktree 和 Verification 属于工作流控制面。已实现的执行层采用声明式
Workflow IR、可替换 Agent Executor、持久化 Execution Journal、有界并发、原生宿主 Adapter、
独立进程协议，以及基于显式 effect/Approval 的隔离 Worktree 写入与 Integrator；它不改变现有
Route 与任务阶段的事实源地位，也不在 Core 中绑定单一宿主。当前已完成 Phase 0-5；动态
Workflow 作者入口只生成和校验声明式 IR，并在执行前绑定静态预览批准。

目标架构、不变量、公共契约边界、风险控制和分阶段退出标准见
[`MULTI-AGENT-EXECUTION-KERNEL.md`](./MULTI-AGENT-EXECUTION-KERNEL.md)，宿主接入见
[`EXECUTOR-PORTABILITY.md`](./EXECUTOR-PORTABILITY.md)，可写执行边界见
[`WRITABLE-EXECUTION.md`](./WRITABLE-EXECUTION.md)，动态作者入口见
[`DYNAMIC-WORKFLOW-AUTHORING.md`](./DYNAMIC-WORKFLOW-AUTHORING.md)。未标记完成并通过契约测试的后续阶段能力
仍视为 Proposed，不得写入 Adapter 或用户文档冒充现有实现。

接入步骤见 [`PORTABILITY.md`](./PORTABILITY.md)。
