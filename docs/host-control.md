# Trusted host control API

`@gk0919/agent-workflow/control` 提供 `WorkflowController`，用于宿主把人工命令与模型能力分开。
它复用现有持久任务、阶段迁移、Route Gate、检查点和验证合同，不定义第二套工作流阶段。
普通 CLI 保持原有用途；该接口不会让模型可执行的 `--user-approved` 变成可信授权。

## Public contract

```ts
import { WorkflowController } from '@gk0919/agent-workflow/control';
const control = new WorkflowController(workspaceRoot);
// 仅由真实人工命令调用：
control.start({ taskId, route, entry, goal });
// 或 control.resume(taskId)，恢复后没有代码写权限。

// 以下调用可通过参数校验后的专用工具开放给模型：
control.files.list();
control.diff(); // 固定只读 Git status/diff/ls-files，不接受模型 argv。
const source = control.files.read('src/example.ts');
control.artifact('plan.md', planMarkdown);
const proposal = control.propose(summary, ['src/example.ts']);

// 人工先核对 status() 中的完整任务方案、summary、文件列表和哈希，再调用：
control.approve(proposal.id);

// 模型工具：完整 UTF-8 文本 + 精确前像；null 前像为新建，null 内容为删除。
control.apply(proposal.id, [{ path: source.path, beforeHash: source.hash, content: newContent }]);
control.dispose();
```

`start` / `resume` / `approve` / `task` / `revoke` / `dispose` 由宿主持有，不注册为模型工具。
模型只能获得显式包装后的文件读取、文档撰写、方案提交和变更提交能力；不要把 controller
对象、动态方法调用器或 bridge 入口直接暴露给模型。

`task(args)` 是人工进入现有 `task` CLI 的公开桥接入口，参数是 argv 字符串数组，不经过 shell，
不能覆盖绑定的 task ID。它调用任何任务操作前都会撤销当前代码写权限。阶段迁移、工作项、
验证开始与记录等仍执行 Core 原有门禁；V2 自动执行使用下面的固定检查器接口。

`context()` 从 manifest 推导当前阶段并通过现有 next/route 物化 Route Packet。Implement 阶段需要本会话
有效批准。宿主必须让模型获得此 Packet；批准与写入校验不证明模型遵守了其中的语义规则。

`artifact()` 仅接收 intake/prd/spec/plan/changes/review/verify.md、verification.json 和 spec-change.json。
验证合同只允许 `planned` / `implemented` 且所有测试仍为 planned、没有证据或执行基线；
验证结果继续由现有人工/CI 证据登记路径处理。该操作撤销批准，写入后发布检查点。

多文档提交使用 `artifacts([{file, content}], expectedToken)`：先在内存核对整批作者权限、
Plan 解析与阶段引用、验证定义及 Spec/contract 配对，再持有 manifest 锁一次发布 checkpoint。
校验失败不写文件、不改变修订号；磁盘写入或 checkpoint 发布发生 I/O 故障仍可能留下未发布文件，
应按既有 reconcile/recover 机制检查，不能把多文件发布视为文件系统事务。
任务快照的 `stageSubmission` 列出作者文档名、当前阶段精确待完成 items，以及 Source Capture
可复用的来源 evidence。Source Capture 不要求模型覆写 source.md，空工作项必须提交 `items: []`。

启用 [能力基线与任务增量](./capability-specs.md) 的任务在 status/delivery 的 task.specChange
返回计算得到的影响与依赖状态。Spec/Plan 出口与写入准入复用同一门禁；存量基线漂移会使活动任务
blocked 并撤销会话写授权。模型可编写任务增量，不能通过 artifact 修改长期基线或伪造测试结果。
其他文件，特别是 manifest、checkpoint、history、verification-start 和 source 快照不开放模型写入。

## Admission and recovery

批准只保存在当前宿主 controller 的私有内存中，绑定任务方案哈希、检查点、仓库指纹、
文件清单及文件前像；磁盘上的历史 approval 不能恢复本会话写权限。批准时要求 Core 进入
Implement，并通过原有产物和仓库门禁。`apply` 在写入前重新通过相同门禁并检查批准绑定。
目录边界、链接/硬链接、Windows ADS/设备路径和受保护元数据在实际文件能力边界检查。

每次批准允许一批变更；提交成功或失败都会撤销批准。成功后重新发布仓库检查点。

`apply` 也接受 `{path, beforeHash, edits:[{oldText,newText}]}`。现有文件的小修改优先使用补丁，
不要求模型重写完整文件。每个 oldText 必须在批准的原文件内唯一精确匹配；多个编辑全部基于
原文件、不得重叠，Core 在同一写锁内先展开全部补丁，再调用原有批次写入。不会模糊匹配或
自动转换换行；未改动文本（含 BOM 与 CRLF）保持原样。新增/删除沿用 content，可同批混用。
外部改动、任务定义变化、恢复、暂停和宿主销毁均不能沿用旧批准。跨 controller 的写入
互斥锁在系统临时目录，避免锁本身污染仓库指纹。锁残留时须确认没有存活写入者后人工清理。

单文件用临时文件加 rename 替换；多文件不是事务。磁盘故障时错误列出已经写入的文件，
检查点失败也明确报告；保留现场，人工核对实际差异后 reconcile，不能盲目重试整个批次。
底层 WorkflowController 仍是同步 API；桌面宿主应使用 AsyncWorkflowController。每个实例拥有一个
固定 cwd 的常驻 Core 子进程，串行持有 controller；状态、进度和产物请求在该进程内执行，
复用已加载模块，不再每次启动 bridge.js。不同工作区不共享 cwd 或批准，宿主事件循环保持响应。
任务变更、路由生成与来源捕获仍调用原有有超时 CLI，沿用门禁。
progress-save 返回已保存进度，省去额外快照和回读；canApply 在没有会话写授权时不扫描仓库，
有授权时仍读取当前基线。没有跨请求缓存批准、检查点或仓库快照。

`onProgress(listener)` 返回解除监听函数，run 依次发出 source、initialize、context；它们是展示信号，
不是阶段、批准或验证证据。doctor 的 coreProcessId 可核对多次请求是否复用同一进程。
变更可信部署或工作区路径配置后应释放旧实例并重建，不在正在执行的实例中热换工作区。

## Enforcement scope

这是可信宿主 API，不是操作系统隔离。部署必须使用固定、可信的插件组合：模型无法修改
插件/Core 的代码或配置，无法卸载 guard，也没有绕开共享工具管线的自定义执行器。
宿主必须拒绝 shell、任意代码、直接文件写入、MCP、子代理和插件管理等旁路能力。
仅隐藏工具名称不构成强制边界。宿主升级后重新验证 guard、工具管线和人工命令来源。
宿主必须在控制插件激活失败时拒绝启动模型工作，不能把尚未安装的 guard 当作存在。

不支持模型与外部进程恶意争抢路径或文件内容；普通外部编辑会使后续批准/提交过期，
但没有 OS 级原子比较替换保证。要求对抗同机进程时应叠加独立账户/容器/沙箱与只读部署。
首版支持一个 controller 对应一个工作区根仓库；多独立仓库和 worktree 自动绑定由已有
执行服务处理，不在此接口中猜测根目录。

Core 回归：`node dist/tests/contract/control-regression.js`，已纳入 `npm run quality:policy`。


## V2 program orchestration

公开 `/control` 增加 `AsyncWorkflowController(workspace, options)`。实例只由可信宿主持有。
`run(target, intent?)` 解析 Markdown 或 Active Profile Provider 编号，Core 分类后创建持久任务；
`resume(taskId)` 恢复进度但不恢复 proposal 和写权限。V3 默认 intent 为 auto：编号使用 Provider 类型，文档默认 requirement；未知事实
不声明 micro Gate；维护 intent 为 workflow-maintenance。分类输入作为可信任务产物保存，
后续通过原有 route CLI 重放，同一任务仍由 manifest 决定 Route/stage。

`delivery()` 返回 task、progress、waitingFor、context。宿主在 model 时调度模型，approval 时
让模型提交 proposal 后等待人工，在 human 时停止，complete 时结束。模型仅能提交：

```ts
{ stateToken, evidence, items: [{ id, evidence }], verdict: 'ready' | 'needs-input' | 'changes-required', reason }
```

`submit()` 检查当前基线、证据引用和当前阶段全部未完成工作项；Core 原有 item/advance/complete
负责依赖与阶段出口门禁。下一阶段由 Route transitions 推导，按声明顺序包含可选阶段，
遇到多个必选分支等待人工决策。进入 Implement 前返回批准屏障，不自动授权。
阶段工具不接受 target、approved、任意 CLI 或检查命令。通过门禁不代表分析内容已被证明正确。

options.checks 是可信部署固定命令注册表：id、command、args、timeoutMs，可选 testId。
Verify 没有配置检查时拒绝自动完成；存在 verification.json 时 testId 必须绑定 agent 的 static/cli
测试点。先 verify-begin，再执行固定命令，最后 verify-record 真实结果与新证据，执行期间
代码/任务基线变化则拒绝通过。所有测试均 passed 且 current 才标记合同 verified。
人工/CI 验证缺口保留，由人工使用原有受信任登记路径处理，不由模型填结果。

options.maxCorrections 只能收紧 security-policy 的 maxConsecutiveFailures；计数、暂停和
错误保存在 task/control-progress.json。模型报告 needs-input 时立即暂停，
changes-required 的标准任务返工行为见下文；不支持返工的 Route 保持暂停，
连续拒绝达到预算时也暂停；只有宿主人工 continue 能重置，重置不继承批准；同阶段的批准屏障与已写入待补证据标记会保留，外部编辑仍须人工核对并 reconcile。
仅此辅助进度文件新增持久化，任务状态仍以原有 manifest/checkpoint 为准。

所有异步操作可传 AbortSignal。预先取消不执行；在途取消等待当前有界操作达到静止点后
暂停并撤权，再报告取消，不强杀正在写入的 Core 进程。发生的写入不回滚；必须检查状态/差异。
宿主 dispose 先等待排队操作并撤权，再等待 Core 进程完全退出，释放 Windows cwd 占用。
IPC 断开后撤销该进程内权限；恢复实例没有旧会话权限。

新增回归 `control-orchestration-regression` 覆盖真实临时仓库完整闭环、固定检查执行与基线、
无检查器/失败检查阻断、重启撤权、持久修正预算与取消。DSH 调度由独立插件适配，不绑定 Core。


## V3 source lookup and reliable continuation

`lookup(reference)` 只读调用 Active Profile Provider，返回 capture 和 intent，不绑定或创建任务。
根据 capture.facts.entry 或 sourceType 与 Profile changeIntents 的匹配识别意图，不在 Core 硬编码编号。
`run(reference, 'auto')` 使用该意图分类；显式 intent 与已识别类型冲突时拒绝。未知 Provider 类型
需要明确意图，不通过猜测降低门禁。编号规则、凭据和远端查询仍由原 Adapter 与 Profile 负责。

`delivery()` 新增 taskDirectory、nextAction、recovery（issue 与 pending），批准屏障与已写批次的
证据收尾状态保存在辅助进度中。恢复可显示未发布产物和仓库变化；这只是只读诊断，所有写入仍
走原有严格 snapshot/admit。已写批次可以继续补充阶段证据，后续新批次始终需要新 proposal/批准。

异步 facade 对 submit/apply 使用稳定内容摘要作为操作编号，回执保存在配置的 runtimeRoot 下
control-operations/taskId，必须被 Git 忽略。回执不进入 task/授权基线，不提供任何授权。
保存记录顺序为 pending → 执行 → 原子发布结果回执 → 移除 pending。成功请求返回已有结果；
明确失败在同一基线下不重试，授权或基线变化后可重新执行，仍通过全部门禁；结果不明绝不自动重试。
阶段重放返回当前 delivery，避免返回过期 Packet。参数对象的键顺序不改变请求身份。
回执保存的是结果或错误，不保存整份请求源码；运行目录属于受保护部署数据，不向模型开放写入。

丢失结果回执的 pending 阻断模型变更与普通 continue。人工核对实际文件和证据、通过现有 task
checkpoint --reconcile 发布现场后，调用 `recover()` 承认已核对结果并撤销历史权限。旧请求记为
不可重放，不自动补做。recover 与受控写入/阶段提交共用文件互斥；残留锁须确认执行者退出后
人工清理。回执存储丢失不等于任务重新开始；权限、前像和阶段基线仍阻断旧请求。

标准任务在 Implement/Review/Verify/Git Inspect 提交 changes-required 时，要求具体 reason 和有效发现证据，
由 Core 既有 reopen 回到 Plan，重置受影响工作项。模型不选择跳转目标，不能直接回到 Implement。

Implement 补交证据使用 items.evidence，保留已批准的 Artifact/Done When 等定义。
文档写入前按批准投影校验：定义变更被拒绝，整批不写入；实际变更记录和进度/证据可继续更新。
代码批次已写入的事实在提交失败与重试中保留，补交证据不重复请求写入批准。
更新计划后重新走 proposal → 人工批准 → Implement。原有验证 freshness 继续生效，不把旧通过
结果重新绑定到新代码。路线不支持 reopen/Plan 时停下来交给人工，不创建隐式新路线。

V3 不包含自动复杂度升级、多仓库绑定或图形批准按钮。完整真实模型/桌面 GUI 验收需单独执行；
回归使用真实 Core 和 DSH 工具管线，模型/人工命令传输由夹具替代，不能称为模型端到端验收。


## V4 controlled discovery and deployment diagnostics

`files.search({query,path?,extensions?,maxResults?})` 提供固定字面量搜索，不接受 shell 或正则。
沿用 canonical path 与文件大小限制，跳过链接与生成目录，限制遍历项、读取总量和结果片段；
返回 scannedFiles/truncated，截断时缩小范围，不能把部分扫描当作全仓库事实。

`rules(skills=[])` 返回可用项目 Skill 名称与当前 Packet。加载技能仍由既有 route --skill 编译，
复用阶段门禁和上下文预算，不新增规则注册表或授权状态。Implementation Packet 仍要求人工批准。

`doctor()` 在未绑定任务时可调用，返回本地 Core/Node/Profile/Provider、Git 根、任务根存在性、
runtime 忽略规则和 Skill 名称；不创建目录、不查询远端，不输出插件 options/凭据。
宿主补充自己的版本与检查器 ID。配置失败保留错误，不静默修复；宿主未公开的信息保持未验证。

DSH V4 使用既有 status/proposal/delivery 构成人工摘要，模型 status 保持结构化。新部署构件
将编译插件与 Core tarball 固定在同一目录，保留摘要核对；不要求修改业务依赖或自动运行检查。
