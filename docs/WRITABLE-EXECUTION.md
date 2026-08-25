# 可写执行与 Worktree 集成

Phase 4 在只读并行执行之上增加显式写入 effect。它不是共享工作树上的并发写入：每个
Run/Node/Lane 都绑定独立 detached Git worktree，写入先形成不可变本地 commit，再由
`integrator` 在另一个独立 worktree 中合并和验证。

## 公共入口

包的 `./execution` export 提供：

- `runWritableWorkflow(options)`：Phase 4 Runner。使用 `WritableExecutionOptions`；只有包含
  repository effect/Integrator 的 Definition 才必须提供 `ExecutionWorkspaceService`，纯外部 effect
  不需要 Git 工作区服务。
- `GitWorktreeWorkspaceService`：Node.js Git worktree 实现。宿主显式提供 workspace、runtime
  state 和 worktree 根目录，以及可选的合并后 Verifier。
- `ExecutionWorkspaceService`：其他宿主实现隔离工作区时遵守的 bind、finalize、integrate、
  recover 契约。
- `execution-workspace-state.json`：本机 Runtime 状态 Schema。该状态包含绝对路径，不能作为
  Portable Artifact 或跨宿主事实源。

`runParallelWorkflow` 和 `runPortableWorkflow` 保持 Phase 2/3 的共享只读策略，不会因为定义中
出现写入字段而隐式升级权限。项目和 CI 不得导入 `src/`，只能使用包 export、Schema 与 CLI。

## Definition 规则

写节点使用 `effect` 声明副作用：

```json
{
  "id": "write-files",
  "type": "map",
  "dependsOn": ["source"],
  "prompt": "Write one declared file.",
  "maxItems": 2,
  "itemsPointer": "/items",
  "permissions": ["workspace:read", "workspace:write"],
  "workspace": {
    "mode": "exclusive-worktree",
    "repository": "."
  },
  "effect": {
    "kind": "repository-write",
    "approvalCheckpoint": "approval",
    "ownedPaths": ["outputs/{lane}.json"],
    "resourceLocks": ["outputs/{lane}.json"]
  }
}
```

机械约束如下：

1. `approvalCheckpoint` 必须引用写节点的上游 `checkpoint`；未经显式批准，Runner 在 checkpoint
   停止。
2. `repository-write` 必须使用 `exclusive-worktree`、声明 repository、`workspace:write` 和 1-50 个
  精确 `ownedPaths`。路径不支持 glob；Map 可用 `{lane}` 生成 lane 级 ownership。
3. `external-write` 不声明仓库 ownership。它仍必须位于 Approval Checkpoint 下游，而且恢复时
  默认不自动重放。
4. `resourceLocks` 在一个调度层内阻止锁冲突的任务同时运行；未声明时仓库写入使用 owned paths，
  外部写入使用节点 ID 作为默认锁。
5. 每个 `repository-write` 必须由且仅由一个直接 `integrator` 消费；Integrator 只能直接依赖同一
   repository 的写入 Agent/Map，并引用同一个上游 Approval Checkpoint。Map 没有 lane 时 Integrator
   生成明确的 `no-changes` 结果，不创建空 commit。
6. `limits.maxExternalWrites` 是全部写 effect 的静态调用上界，包括每个 Map lane 和 Integrator；
  定义超过上限时在首个事件前拒绝。

通用 Schema 和 Core 只接受中立标识、相对 repository/path 和通用权限，不包含项目名称、任务
前缀、Skill 或宿主仓库路径。

## 执行顺序

```text
Checkpoint approved
        |
        v
bind(Node/Lane) -> isolated worktree @ common base commit
        |
        v
effect-prepared -> Executor writes declared paths
        |
        v
ownership check -> git diff --check -> local effect commit
        |
        v
effect-confirmed
        |
        v
Integrator worktree -> collision check -> cherry-pick --no-commit
        |
        v
post-merge verifier -> integration commit -> effect-confirmed
```

所有同仓库 binding 在一个 Run 中固定到首次 bind 的 base commit，避免 lane 因宿主分支移动而使用
不同基线。Executor Request 可以收到 host-local `rootPath`；Journal Event 和内容寻址 Artifact 只记录
`bindingId`、repository、base commit、changed paths 和 commit，不持久化绝对路径。

合并前先检查多个 change 是否声称修改同一路径；检测到碰撞直接返回 `merge-conflict`。随后 Git
仍会检查内容冲突。冲突 worktree 保留在 Runtime 供人工诊断，不会写入或覆盖调用者的主工作树。

合并后先执行 `git diff --cached --check`，再调用宿主 Verifier。Verifier 必须只读；验证前后
changed paths 不一致会以 `post-merge-verifier-mutated-workspace` 失败。任何 error finding 都阻止
integration commit，并以 `verification-failed` 结束 Run。

## 恢复矩阵

| Journal / Workspace 状态 | Runner 行为 | 是否再次调用 Executor |
|---|---|---|
| 没有 `effect-prepared` | 创建稳定 effect ID 并执行 | 是 |
| repository effect 已 prepared，worktree 仍为干净基线 | 使用原 attempt/effect ID 重新执行 | 是 |
| repository commit 已存在但 `effect-confirmed` 未写入 | `recover` 确认唯一 commit，补写事件 | 否 |
| repository 状态不明确 | `run.paused: effect-recovery-required` | 否 |
| external effect 已 prepared但未 confirmed | 暂停，要求人工核对外部系统 | 否 |
| external effect 已 confirmed 但节点未 completed | 校验 Artifact 后补写 completed | 否 |
| Integrator 已生成唯一 commit 但事件未确认 | 用相同 effect ID 返回已完成 integration | 否 |
| Integrator 留下 staged/conflicted 中间态 | 暂停或明确冲突，不重复 cherry-pick | 否 |

`node.effect-prepared` 是副作用调用前的 durable intent，`node.effect-confirmed` 是可恢复确认点。
外部系统没有 Workspace Service 可供机械核对，因此“可能已经发生”必须按 ambiguous 处理，不能把
at-least-once 重试伪装成幂等。

## 宿主责任与边界

- `workspaceRoot`、`stateRoot`、`worktreeRoot` 必须由宿主显式提供；state/worktree 根位于
  workspace 内，且不得是 symlink。若它们位于 repository 内，宿主必须通过 `.gitignore` 排除。
- Git 调用使用参数数组、`shell: false` 等价的进程边界、literal pathspec 和固定超时；Workflow
  不能提供命令、Git 参数、commit message 或 Verifier 命令。
- 默认实现只创建 detached 本地 commits，不移动主分支、不 checkout 主工作树、不 push，也不删除
  诊断 worktree。分支更新、清理、commit、push 和发布仍是独立授权动作。
- Verifier 由宿主注入，并应运行与目标仓库相称的测试。Agent 自报 findings 不能替代合并后验证。
- `.agent-workflow/runtime/`、execution workspace state、worktree 和本地 Run 数据不得提交。

运行 Phase 4 conformance：

```text
agent-workflow execution:writable:test
```

该回归使用临时真实 Git 仓库，覆盖 lane worktree 隔离、资源锁并发、ownership 越界、Integrator
碰撞、合并后验证失败、repository commit 恢复，以及 external effect 在 confirmed/unconfirmed
崩溃窗口中的不重放语义。
