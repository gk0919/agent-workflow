# Adaptive Dynamic Workflow Runtime

Phase 6 在动态作者入口之上提供运行时重规划，但不允许修改正在执行的 DAG。每个 Workflow Run
仍然对应一个不可变的 Definition 和 `workflowHash`；自适应执行只能在已持久化的 Checkpoint
暂停边界，把当前 Run 收口为一个执行段，并启动经过独立预览和批准的子 Run。

## 信任流

```text
Parent Run paused at Checkpoint
  -> WorkflowTransitionRequest
  -> Parent identity/checkpoint validation
  -> Child Definition validation and policy gate
  -> Cumulative lineage budget preview
  -> WorkflowTransitionApproval
  -> Parent run.transitioned
  -> Child run.created
  -> Child run.plan-approved
  -> Child Runner
```

禁止在单个 Run 中原地增加、删除或重连节点。这样 Journal 中的每个事件始终只对应一个稳定的
`workflowHash`，现有恢复、取消、副作用和 Worktree 语义不需要接受可变图。

## Transition 契约

`WorkflowTransitionRequest` 包含稳定的 `transitionId`、Parent 身份与 Checkpoint、Child Definition、
Child 执行模式，以及整条 lineage 的累计预算上限。公开 Schema：

```text
@gk0919/agent-workflow/schemas/workflow-transition.json
```

请求必须通过严格 Schema、Child Definition DAG 语义和执行模式策略。Parent Definition 的哈希、
Journal 身份和 Checkpoint 暂停事件也必须完全匹配。

## 累计预算

每次 Transition 使用声明上界进行预留，包括：

- `depth` 和 Definition 数量；
- `totalAgents`；
- `totalDurationMs`；
- `totalExecutorCalls`；
- `totalExternalWrites`。

首个 Transition 的限制会写入 Child 的批准上下文。后续 Transition 必须复用完全相同的限制，
不能通过创建更深的子 Run 扩大预算。

## 批准与 Journal

`WorkflowTransitionPreview` 绑定 Parent、Child 完整预览、累计预算、限制和执行模式，并生成
`transitionHash`。`WorkflowTransitionApproval` 同时绑定 `transitionHash`、`childPreviewHash`、
`parentWorkflowHash`、Child `executionMode` 和 Schema 版本。

批准通过后，Parent Journal 追加 `run.transitioned`，其结果 Artifact 记录
Child Run 和 Transition 身份。Child 在 `run.started` 前追加 `run.plan-approved`，持久化作者批准和
完整 lineage 上下文。两者使用 Execution Event v2；当前读取器仍接受旧 v1 Journal，并在获得当前
批准后于恢复边界补写 v2 `run.plan-approved`。普通静态 Runner 不产生批准事件。

## 恢复与并发

- Parent 收口通过 Journal 序号和 hash 链竞争，同一 Checkpoint 只有一个 Transition 获胜。
- 相同 `transitionHash + childRunId + inputHash` 的顺序重试是幂等的；并发竞争者可能收到冲突并重试。
- Parent 已收口而 Child 尚未开始时，重复调用会启动 Child。
- Child 已有事件时，重复调用使用现有 Runner 的 `resume` 路径。
- 不同 Transition 或不同 Child Run 复用已收口 Parent 时会被拒绝。

## 公共 API

```ts
import {
  createWorkflowTransitionRequest,
  previewWorkflowTransition,
  runApprovedWorkflowTransition,
} from '@gk0919/agent-workflow/execution';
```

宿主负责提供 Parent/Child `ExecutionJournalStore`、Executor、Child input，以及 writable 模式所需的
`ExecutionWorkspaceService`。Core 不调用特定模型，也不绑定宿主私有会话状态。

## CLI

```text
agent-workflow execution:adaptive:preview \
  --parent-file parent.json --parent-run-id run-... --checkpoint approval \
  --file child.json --transition-id next-plan --mode serial --limits limits.json

agent-workflow execution:adaptive:run \
  --parent-file parent.json --parent-run-id run-... --checkpoint approval \
  --file child.json --transition-id next-plan --mode serial --limits limits.json \
  --child-run-id run-... --fixture fake.json --approval <transition-hash>
```

CLI 使用 Fake Executor，面向契约验证和本地集成。生产宿主应通过公共 API 注入真实 Executor。
`writable-worktree` 可预览，但 CLI 不创建真实 Workspace Service。

## 明确边界

Phase 6 实现的是 Checkpoint 间的版本化运行时重规划，不是任意图热更新：

- 不支持执行中的节点热替换；
- 不支持无界递归或未声明深度的子 Workflow；
- 不支持模型绕过 Transition Preview 直接调度；
- 不把父子 Run 合并为同一个 Journal hash 链；
- 不提供绑定单一模型供应商的作者调用。

`map` 负责单个静态 Definition 内的有界数据展开；Transition 负责 Definition 之间的受控重规划。
