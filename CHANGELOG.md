# Changelog

## Unreleased

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
