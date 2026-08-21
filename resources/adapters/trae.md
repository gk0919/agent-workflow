# TRAE Adapter

适用于 TRAE IDE、Agent 或具备类似能力的版本。遵守 [`Tool Adapter Contract`](./README.md)，不依赖某个版本的专有规则目录或 UI 名称。

## Bootstrap

当前版本能识别 `AGENTS.md` 时，直接由根目录入口进入 setup 写入的实际 `START.md` 包路径。如果只能使用 Project Rules，则创建一条仅指向该路径的薄规则。

如果两种自动加载方式都不可用，运行 `agent-workflow setup --agent generic` 获取启动提示。不要把完整项目规范复制进 TRAE 专属配置。

## Capability Mapping

开始任务时确认当前版本和会话实际支持哪些能力：

- Repository Read / Edit：可用时执行最小修改；不可用时输出 patch。
- Command：只运行项目策略允许的命令，并服从其中登记的构建与测试限制。
- Rules / Context：用于加载事实源，不保存唯一任务状态。
- MCP / Connector：可用时受控读取外部事实；不可用时执行项目策略中的降级路径。
- Multi-Agent / Background：可用时按 `agent-workflow/docs/09-runtime.md` 分工；不可用时串行执行。

## Portable Handoff

- 接手业务任务前用 `portable-resume` 读取 manifest/source/handoff 当前摘要，再核对仓库状态。
- TRAE 的会话历史、内部计划、检查点或记忆不能替代标准阶段产物。
- 离开 TRAE 前更新当前阶段、下一动作、改动文件、Review、Verify 和未授权 Git 动作。

## Fallback

- 无法自动发现 `AGENTS.md` 时显式读取。
- 无法调用项目 Skill 时，读取 `.agents/skills/<skill>/SKILL.md` 及其引用文件。
- Pool Entry 无法调用 MCP 时，按 `source-capture.md` 使用只读 CLI；无法执行 CLI 时要求用户提供该命令的完整 JSON 输出。Direct Entry 不调用 MCP 或 CLI。
- 无法执行命令时，列出人工命令、预期检查点和未验证风险。

## Tool-specific Safety

- 不假设不同 TRAE 版本具有相同的 Rules、Agent、MCP 或后台能力。
- 不把工具生成的计划状态视为已经完成的阶段证据。
- 工具专属权限或自动化不能放宽项目规则和用户授权。
