# 动态 Workflow 作者体验

Phase 5 在 Phase 0–4 的声明式执行内核之上增加安全作者入口。它允许模型、宿主或 Builder 生成
Workflow Definition，但不会加载或执行生成的 JavaScript。所有动态输出必须先成为严格 JSON IR，
再经过 Definition Schema、DAG 语义和执行模式策略校验。

## 安全流程

```text
不可信模型/宿主输出
        │
        ▼
parseWorkflowDefinitionOutput
Schema + 语义校验；只接受 JSON Definition / Bundle
        │
        ▼
previewWorkflowDefinition
图 + 预算 + 权限 + 能力 + 仓库 + effect + checkpoint
        │
        ▼
用户/宿主批准精确 previewHash
        │
        ▼
runApprovedWorkflow
重新计算预览并核对回执，然后委托 Phase 1/2/4 Runner
```

批准不能替代运行中的 Checkpoint Approval。前者允许指定动态图以某种模式启动或恢复；后者仍控制
节点 effect、外部写入和 repository integration。Definition、依赖、Prompt、预算、权限、能力、
Workspace、effect 或执行模式任一变化都会改变 Definition/Preview Hash，使旧批准失效。

## 模型输出边界

```ts
import {
  parseWorkflowDefinitionOutput,
  previewWorkflowDefinition,
} from '@gk0919/agent-workflow/execution';

const definition = parseWorkflowDefinitionOutput(modelJsonText);
const preview = previewWorkflowDefinition(definition, 'parallel-readonly');
```

输入可以是 JSON 字符串、已解析对象或 `workflow-definition-bundle`。Markdown fence、说明文字、
未知字段、非本地 JSON Schema 引用、无界图、无效依赖以及超限 Definition 都会在预览前拒绝。

支持的执行模式：

- `serial`：复用 Phase 1 只读串行策略。
- `parallel-readonly`：复用 Phase 2 有界只读并行策略。
- `writable-worktree`：复用 Phase 4 effect、Approval、Worktree 和 Integrator 策略。

预览包含：

- 确定性静态 Plan、层级和 Definition Hash；
- 节点数、最大层宽、最大 Executor 调用数和最大 effect 调用数；
- 完整声明权限、required/preferred capability 和 repository 集合；
- Checkpoint 摘要与 effect 的节点、类型、批准点、ownership 和资源锁；
- 绑定上述全部内容及执行模式的 `previewHash`。

## 批准后执行

宿主只有在取得当前用户对预览的明确批准后，才能构造 `WorkflowExecutionApproval`：

```ts
const approval = {
  executionMode: preview.executionMode,
  previewHash: preview.previewHash,
  schemaVersion: 1,
  workflowHash: preview.workflowHash,
} as const;

const result = await runApprovedWorkflow({
  approval,
  definition,
  executionMode: preview.executionMode,
  executor,
  input,
  store,
});
```

`runApprovedWorkflow` 在任何 Journal 写入前重新解析 Definition、重新生成预览并严格比较批准回执。
宿主应把“谁批准、何时批准、交互证据”保存在自己的控制面审计记录中；这些身份字段不会进入
可由模型填写的 Core Definition。

CLI 使用显式预览哈希：

```text
agent-workflow execution:author:preview \
  --file workflow.json --mode parallel-readonly --format json

agent-workflow execution:author:run \
  --file workflow.json --fixture fake.json \
  --scheduler parallel --approval <previewHash>
```

CLI 的 `--approval` 不匹配时不会创建 Execution Run。当前 CLI fixture 入口只开放 `serial` 和
`parallel-readonly`；`writable-worktree` 由宿主公共 API 注入 `ExecutionWorkspaceService`。

## Builder

`WorkflowDefinitionBuilder` 只收集节点并在 `build()` 时生成、校验和冻结 Definition IR；它没有
`run`、工具调用、文件写入或动态代码加载能力：

```ts
const definition = new WorkflowDefinitionBuilder('review-flow', limits)
  .addNode({ id: 'review', prompt: 'Review input.', type: 'agent' })
  .setResultNode('review')
  .build();
```

Builder 是可选便利层。JSON Definition 与 Schema 仍是唯一可移植事实源。

## 保存、版本和迁移

`WorkflowDefinitionBundle` 使用独立 Schema v1，保存：

- `workflowId`、单调递增的正整数 `version`；
- `source`：`model`、`builder`、`human` 或 `migration`；
- Definition 内容 Hash；
- 可选上一版本号和 Definition Hash；
- 完整 Workflow Definition v1。

```text
agent-workflow execution:author:save \
  --file workflow.json --output workflows/review-v1.json \
  --version 1 --source model

agent-workflow execution:author:migrate \
  --file legacy-definition.json --output workflows/review-v1.json
```

保存命令拒绝覆盖已有文件。迁移器把旧的裸 Definition v1 包装为当前 Bundle v1；当前 Bundle 只做
严格校验和规范化，不伪造未来版本迁移。未知 Bundle/Definition Schema Version 会明确拒绝。

## 兼容与验证

Phase 0–4 的 `compileStaticExecutionPlan`、`runSerialWorkflow`、`runParallelWorkflow`、
`runPortableWorkflow` 和 `runWritableWorkflow` 保持兼容。只有处理动态/模型作者输出时才使用 Phase 5
入口。

宿主接入至少运行：

```text
agent-workflow execution:author:test
```

回归覆盖模型 JSON 边界、模式策略、图/预算/权限批准漂移、无 Journal 写入拒绝、Builder、Bundle
Hash/版本、迁移以及 CLI preview/save/migrate/run。
