# Generic Host 示例

此目录是由 `agent-workflow init` 生成并经过端到端检查的只读展示基线，包含宿主配置、继承默认值的 Profile、根 Bootstrap、本地状态忽略规则、npm scripts 和 GitHub Actions Workflow。契约测试会把临时初始化结果与此目录比较，防止生成器漂移。

宿主不得复制此目录或依赖其中的 `file:../..`、`generic-host` 标识和占位策略。接入其他仓库时：

1. 在目标仓库安装固定版本的 `@gk0919/agent-workflow` 包或 `.tgz`。
2. 运行 `npm run workflow:init`，校准自动生成的宿主文件。
3. 将项目约束放入 `AGENTS.md`，绑定关系放入 `.agent-workflow/profile/profile.json`，领域 Skill 放入 `.agents/skills/`。
4. 依次运行 `npm run workflow:setup`、`npm run workflow:init:check`、`npm run workflow:profile`、`npm run workflow:context` 和 `npm run quality:policy`。

Profile 继承中立默认值：对象递归合并，数组整体替换继承值；运行时数据和本地任务状态继续保持忽略。

npm 发布产物会排除嵌套的 `.gitignore`，因此 `gitignore.template` 是本示例 `.gitignore` 的打包副本；消费方仓库运行 `agent-workflow init` 时仍会生成真正的 `.gitignore`。
