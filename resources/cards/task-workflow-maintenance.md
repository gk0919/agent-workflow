# Workflow Maintenance Card

工作流文档是事实源，运行提示由 Router 编译。检查：是否重复规则、是否把深度参考放入启动链、是否可由脚本确定、是否有上下文预算和路由回归用例。

不创建业务 Source Snapshot。修改脚本后执行代码审查；不运行项目构建或业务测试。
运行反馈只看 `workflow:feedback` 聚合，不把原始日志加入上下文；重复问题先进入
knowledge `_staging`，人工晋升后仍需显式链接到 Skill 或 Reference。

用户要求“生成候选知识”时，不只创建模板：读取当前任务已有沉淀、业务仓库 diff、评审与验证结果，检索已有 staging / approved 知识去重，在同一轮生成内容完整且通过 `workflow:knowledge -- lint` 的候选。只提炼经过证据支持、可跨任务复用的结论；业务实例值必须标明复用边界。

用户明确确认当前唯一候选“没问题”“批准”或同等含义时，执行 `workflow:knowledge -- approve --id <id>` 自动记录当前会话用户确认并晋升。多个候选或指代不清时不得猜测；晋升仍不等于自动加载，链接 Skill 或 Reference 需要独立改造和质量检查。
