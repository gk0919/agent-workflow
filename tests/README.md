# Tests

- `contract/`：验证公开 CLI、配置解析、路由、状态和安全策略的确定性契约。
- `fixtures/`：只存放与具体宿主项目无关的最小测试数据；需要空目录时保留 `.gitkeep`。

项目与 CI 应通过 `agent-workflow` CLI 运行契约测试，不直接依赖测试文件路径。
