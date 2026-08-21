# Micro Change Card

Micro Change 支持 `defect` 和 `requirement`，只压缩流程成本，不降低质量门禁。

通用 Gate：数量以 `routes.json.microChangeGate` 为准；目标、验收、唯一落点和验证入口明确；无接口、数据结构、持久化、权限、安全边界、公共链路、异步生命周期、高风险、迁移、发布协同或外部写入。

需求须复用现有交互和技术模式，不新增业务状态，兼容明确。事实未知、范围扩大或语义歧义时立即切换 `standard-change/capture`，保留已确认事实。

仍须在正确责任层消除根因或维护需求不变量；当前值特判、重复规则/状态、仅修展示，或治本
需要公共链路、接口、数据模型、新抽象时立即升级。

Change Brief 保存可追踪的 `G` / `AC` / `OOS` / `C` / `VT`；VT 写明方式、主体、前置条件
和预期。Implement 起用 `--micro-brief-file` 提交 JSON Brief，同一 Run 计划哈希不得漂移；
工具存在不代表能力、授权和环境已就绪。

`--repository` 在 Locate 是提示，Implement 若传则匹配 Brief，Review 起绑定来源。每次 Packet
重验 Gate；Review、Verify、Git Inspect 前用 `--micro-patch-file`（Windows 首选）或 stdin
提交任务 patch，校验仓库、文件数、语义行数及 `--repository`、Change Inventory、patch 清单一致。
