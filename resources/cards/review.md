# Review Card

只审查任务专属 patch，按严重度报告有证据的 Findings；无问题时明确说明。使用 Route Packet 的 Active Profile 所声明的 Review Skill，只加载 patch 实际命中的主题 Reference。UI 只选择命中场景的 Skill。

核对任务一致性、边界、异常、兼容性、生命周期、安全和无关改动。Micro Change 按意图卡增加检查：`defect` 核对根因与回归点，`requirement` 核对验收、默认状态、旧行为兼容和权限边界。

核对实际修改是否位于正确责任层并形成最小完整语义闭环；将只覆盖当前案例的特判、重复规则/
状态、用兜底掩盖上游错误，以及缺少同类/扩展/异常场景证据列为 Finding 或 Test Gap。

核对关键逻辑和公共契约是否缺少原因/约束/不变量说明，已有注释是否准确同步；重复代码含义、
过期注释、裸 TODO / FIXME 和注释掉的旧代码进入 Finding。机械 Warning 必须人工复核，不自动等同缺陷。

核对 Goal & Verification Contract 的 `G -> AC -> C -> A -> VT`：实际文件以任务 patch
为准，每个 AC 有测试点，MCP / CI / manual 的执行主体和状态没有被伪造。缺少追踪关系进入
Finding 或 Test Gap，不能留给 Verify 临时补目标。

发现接口、数据、权限模型、公共链路、异步生命周期、新业务状态、新交互模式或影响范围扩大时，升级标准流程。

安全审查同时核对不可信内容是否被当成指令、工具权限是否来自当前授权、外部写入是否绑定具体参数，以及是否存在无界重试或工具链。
