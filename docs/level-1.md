# level-1

level-1 是低风险路由；意图决定 Review 和 Verify 重点。

## L0 level-0

L0 是比 level-1 更轻的呈现改动路由，与 L1 `level-1` 并列：L1 改变行为（恢复缺陷或交付需求增量），L0 只改变呈现（样式、文案、格式），不含行为变化。

- 入口只接受 `direct`（不接受 Provider Entry）。
- 必须显式声明 `--level 0`：`level-0` 在 `routes.json` 声明 `requiredLevel`，缺少声明即确定性拒绝，不接受“沉默即默认 L0”。`--level` 只被声明了 `requiredLevel` 的 Route 接受，7 条 `task-*` 任务类型路由传入该参数一律拒绝。
- 事实必须落在 L0 包络内：change type 为 `cosmetic`，满足既有 Micro 门禁数值，且不带任何风险标识。事实推导等级高于声明等级时确定性拒绝，并在错误信息中给出事实推导出的等级。
- 等级由 `--level` 声明、由事实校验：声明低于事实推导等级会被拒绝，声明更高则按更严流程执行。
- 不放松任何门禁：复用 Micro 守卫链路（任务专属 patch、仓库与来源绑定、Brief 计划绑定）与既有 Micro 门禁数值；产物仍是最简 Brief，只是卡片与上下文包更小。
- 阶段：`locate-cosmetic` → `implement` → `review-cosmetic` → `verify-cosmetic` → `git-inspect`。

出现行为变化、风险标识、超出 Micro 门禁数值或界面语义不明确时 L0 不再成立：停止扩大修改，记录触发条件并升级 `level-1`(L1)，必要时直接升级 `level-2`(L2)、`level-3`(L3) 或 `level-4`(L4)，不得留在 L0。

## Gate

业务任务先完成 Source Lite，随后必须同时满足：

- Conversation 模式；未要求落盘、异步、跨会话或独立审查。
- 目标行为、当前状态与验收结果明确，不存在截图、样式或业务语义歧义。
- 通过精确线索定位到唯一实现，或已有明确的项目内正确模式。
- 仓库数、文件数和语义 diff 阈值满足 `routes.json.changeGate`。
- 不修改接口契约、数据结构、持久化、权限模型、安全边界、公共组件或公共链路。
- 不新增或修改事件监听、定时器、异步生命周期、批量处理或高风险操作。
- 不涉及迁移、跨模块协作、发布协同、外部写入或不可逆操作。
- 存在目标静态检查或人工入口，并能形成 `G -> AC -> C -> A -> VT` 追踪。

`requirement` 还必须满足：

- 行为增量能够用 1～3 条确定性条件验收。
- 复用现有交互、数据和技术模式。
- 不新增业务状态、枚举、配置结构或入口权限。
- 旧数据、旧配置、旧入口及默认状态的兼容策略明确。

## 路由

```text
Source Lite
-> Change Brief (Defect / Requirement)
-> Locate
-> Implement
-> Focused Review
-> Targeted Verify
-> Git Inspect
```

level-1 不生成正式 Spec 或任务目录。需要持久化、交接或升级标准流程时，再创建最小 Spec 包。

## 运行时门禁

- `workflow:route` 必须同时接收 `--intent` 和完整结构化 Gate 事实；单独指定
  `--route level-1` 会被拒绝。
- 首次 Packet 自动生成匿名 Run ID，同 Route 后续阶段复用；升级或切换 Route 时创建新 Run，
  并在新 Route 首阶段用 `--parent-run-id <old-run>` 保留血缘，禁止跨 Route 复用同一 Run。
- 从 [`brief.sample.json`](../resources/examples/brief.sample.json)
  复制 Brief 到本地忽略目录 `.agent-workflow/runtime/briefs/`。Implement 起使用
  `--brief-file`；Review 起必须补充 Actual Change，Git Inspect 前必须填写 VT 状态和
  Evidence / Gap。计划字段的匿名哈希在同一 Run 内不得变化。
- Locate 可选使用 `--repository` 提供已确认的目标仓库提示；该阶段只校验工作区边界和 Git
  仓库身份，不执行 patch 来源绑定。Implement 若传入同一参数，还会与 Brief Repository 对齐。
- Locate 完成后按 Implementation Approval Card 展示原因/依据、修改点和验证项并停止；只有
  用户在当前会话明确批准后，Implement 才允许使用 `--user-approved`。方案变化必须重新批准。
- Review、Verify 和 Git Inspect 使用 `--patch-file` 或 `--patch-stdin` 接收
  任务专属 unified diff，并强制通过 `--repository` 指定工作区相对 Git 仓库。Windows 优先让
  Git 用 `diff --output=<file>` 写入 `.agent-workflow/runtime/patches/`，再传文件路径，避免
  PowerShell 管道和 npm 参数转发。补丁必须是 200 KB 以内的 UTF-8 文本，内容不写入日志。
- Review 起要求 Brief 的 Repository / File 与 patch 完全一致；patch 还必须反向应用到指定
  仓库当前内容，并把仓库、HEAD 和 patch 合成匿名来源绑定，后续阶段不得漂移。
- 实际补丁包含二进制、子仓库指针或超过 `routes.json.changeGate` 数量阈值时，停止当前路由并
  切换 `level-2/capture`。

## Defect Brief

- 实际现象与预期行为。
- 复现证据、根因或项目内正确模式。
- In Scope / Out of Scope。
- 回归点和可观察验收结果。
- 按 [`verification-contract.md#level-1`](./verification-contract.md#level-1)
  记录计划文件、实际改动、测试点、执行主体和验证证据。

## Requirement Brief

- 用户场景、当前行为与目标行为。
- In Scope / Out of Scope。
- 复用的项目模式与兼容策略。
- 1～3 条可观察验收标准。
- 按紧凑契约为每条验收映射计划文件和测试点。

## 升级

任一 Gate 不再成立时，停止扩大修改，记录触发条件并切换到 `level-2/capture`。升级时保留 Source Lite、定位证据与 Change Brief；进入 Spec 后再按标准流程落盘。
