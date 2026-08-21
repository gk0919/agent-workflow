# Changelog

## 1.0.0

- 将通用工作流引擎与项目 Profile、任务产物和运行状态物理分离。
- 增加稳定的 `agent-workflow` CLI 入口。
- 建立 `src/`、`resources/`、`docs/`、`migrations/` 和 `tests/` 包边界。
- 使用 TypeScript 7、NodeNext ESM 和严格类型配置重构 CLI、Core、Validator 与契约测试。
- 构建产物同时输出 JavaScript、source map、类型声明和 declaration map。
- GitHub Actions 在 Node.js 20/22/24 上执行依赖锁定安装、类型检查、政策门禁、打包和安装冒烟验证。
