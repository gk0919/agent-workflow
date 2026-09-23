# Changelog

## Unreleased

- **破坏性变更**：Route 名改为等级制与统一前缀，且不保留兼容别名。等级路由为 `level-0` … `level-4`（原 `quick-change`、`micro-change`、`standard-change`、新增 L3、`architecture-change`），任务类型路由统一为 `task-` 前缀（原 `analysis`、`review-only`、`git-only`、`pool-capture`、`portable-resume`、`workflow-maintenance`，`task-handoff` 不变）；随名改名的卡片与文档为 `cards/level-0.md`、`cards/level-1.md`、`cards/task-workflow-maintenance.md`、`cards/task-portable-resume.md`、`docs/level-1.md`、`docs/13-level-4.md`。旧名调用会因未知 Route 或事实判定不一致被拒；宿主自定义 Profile 引用旧名须同步更新；`routes.json` 版本升到 8。
- `--level <0-4>` 成为五个等级 Route 的唯一入口（`--route` 可选且同时给出必须一致）：五个等级都要求 `--intent` 与完整 Gate 事实，事实是下限，声明低于事实推导等级会被拒绝并给出应改用的 `level-N`，声明更高则按更严流程执行；新增 `modules` 事实与 `state-refactor`、`performance-program` 两个风险标识，`level-3` 由跨模块事实自动选中，L2 与 L3 的边界即「跨模块或命中这两个风险标识」。
- 增加 L4 路由 `architecture-change`：跨模块或跨仓库的架构级变更由 `--intent architecture` 进入，流程包含架构评审、里程碑与多仓库协同阶段，门禁与既有卡片复用 `standard-change` 同级约定；该路由不声明结构化事实分类，事实自动升级到 L4 尚未实现，必须显式切换，且不得在无人值守、后台或异步模式下自行完成。
- 修复 Implementation Approval Gate 的适用范围与声明不一致：`route --stage implement`、`next`、`advance` 与 `reopen` 统一读取 Route 的 `implementationApprovalRequired` 声明，`workflow-maintenance` 进入 Implement 现在同样要求 `--user-approved`；语法门禁不再把子进程启动失败误报为语法错误。
- 增加 L0 路由 `quick-change`：纯外观改动（样式、文案、格式）只接受 `direct` 入口且必须显式声明 `--level 0`，事实落在 L0 包络内才通过；复用 Micro 门禁数值与守卫链路，超出包络即升级 `micro-change` 或 `standard-change`；`routes.json` 版本升到 7。
- 完成多 Agent 执行内核 Phase 5：模型/Builder 声明式 IR、静态图/预算/权限预览、哈希绑定批准后执行，以及 Workflow Definition Bundle 保存、版本和迁移工具。
- 完成多 Agent 执行内核 Phase 6：Checkpoint-bound Transition、父子 Run lineage、累计预算、Execution Event v2 批准 Journal、原子收口与幂等恢复。
- 修复 Adaptive Runtime 在 Child 仅写入 `run.created` 或 `run.created + run.plan-approved` 后中断时无法恢复的问题，并拒绝顺序异常的初始化 Journal。
- 修复 Micro Change Source Gate 在 Windows 上通过同步 stdin 校验中文补丁时可能超时并误报 patch mismatch；Git 改读受控临时文件，并正确解码 Git 引号路径。
- 完成多 Agent 执行内核 Phase 4：显式写入 effect、Approval、Run/Node/Lane 隔离 Worktree、文件 ownership/资源锁、Integrator、合并后验证和副作用恢复协议。
- 增加 `agent-workflow init`，安全生成宿主配置、Profile 覆盖层、目录、根入口、忽略规则和 npm scripts。
- Profile 支持带循环、深度和路径门禁的 `extends` 递归覆盖；对象合并，数组替换。
- 补齐工作流 npm script 契约，并增加只用于展示和回归的 `examples/generic-host/` 基线。
- 将项目专属兼容内容移出通用可移植文档。
- 将 MCP Source Provider 从 `examples/` 迁移为 `src/plugins/` 下的正式公共模块，宿主通过 `@gk0919/agent-workflow/plugins/mcp-source-provider` 使用。

## 1.0.0

- 将通用工作流引擎与项目 Profile、任务产物和运行状态物理分离。
- 增加稳定的 `agent-workflow` CLI 入口。
- 建立 `src/`、`resources/`、`docs/`、`migrations/` 和 `tests/` 包边界。
- 使用 TypeScript 7、NodeNext ESM 和严格类型配置重构 CLI、Core、Validator 与契约测试。
- 构建产物同时输出 JavaScript、source map、类型声明和 declaration map。
- GitHub Actions 在 Node.js 20/22/24 上执行依赖锁定安装、类型检查、政策门禁、打包和安装冒烟验证。
