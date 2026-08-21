# Codex Adapter

适用于 Codex CLI、Codex desktop 或具备代码编辑工具的 Codex 环境。

遵守 [`Tool Adapter Contract`](./README.md)。Codex 的工具、Skills、计划和子 Agent 都是增强能力，不是流程事实源。

## 执行方式

- Codex 通过根目录 `AGENTS.md` 进入 `agent-workflow setup` 写入的实际 `START.md` 包路径，用 Router 生成当前阶段 Packet；不预读完整工作流。
- Provider Entry 使用 Route Packet 的 Active Profile Source 绑定；如果 Connector 未静态展示，先搜索完整工具注册表，不得直接判定未加载。Direct Entry 不搜索或调用 Provider 补全。
- Portable 业务任务先使用 `portable-resume`，只读取 manifest/source/handoff 当前摘要；确认 Current Stage 后生成实际 Packet。
- 根据任务类型选择最小充分流程，不对分析、定位或评审任务强制套用完整开发流程。
- Router 先区分 `defect` / `requirement`，再判断 Micro Change；满足时使用对话内 Source Lite 与对应 Change Brief，不创建任务目录。
- 有精确页面路径、文件名、函数名、错误码、菜单 ID 或界面文案时先使用 `rg`；结果不唯一或需要模块判断时再读项目地图。
- 修改文件前说明将修改的范围。
- 使用可用工具编辑文件，并保持最小改动。
- 修改后只运行项目规则允许的检查；项目禁止 Agent 运行构建或测试时，不得执行，并把建议命令和未验证项交给用户。
- 最终回复包含变更摘要、验证结果和未验证项。
- 标准流程的正式业务 Spec 及其最小追踪包按 `agent-workflow/docs/03-spec.md` 自动落盘；Micro Change 不生成正式 Spec。其他任务产物默认保留在对话中，只有用户要求完整落盘、可追溯记录或异步交付时才按 `agent-workflow/docs/12-artifacts.md` 创建。
- 用户说明可能切换工具时进入 Portable 模式；Codex 计划状态不能替代任务目录。

## Git

- 默认只执行 Git Inspect，检查每个目标仓库的 `git status` 和 diff。
- 用户未要求时不 stage、commit、push 或创建 PR。
- stage、commit、push 和创建 PR 是相互独立的授权动作。
- 多仓库任务按仓库分别检查、分别授权、分别报告。

## Review

- 对代码评审请求采用 review-first 输出。
- 对实现任务必须在最终结果中说明 review 和 verify 覆盖情况。
