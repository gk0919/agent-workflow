---
id: worktree
description: 为任务按独立 Git 仓库创建、绑定、检查和清理隔离工作树。
tags:
  - workflow
  - git
load: manual
---

# Worktree Card

仅在任务已定位到确切仓库和目标文件、且需要隔离用户已有改动或并行执行时加载。根治理仓库与
Active Profile 声明的独立业务仓库分别处理；一个任务涉及多个仓库时，每个仓库单独绑定 worktree。

先运行只读预检：

```text
npm run workflow:worktree -- plan --task <task-id> --repository <root> \
  --base <ref> --target <repository-relative-file>
```

`create`、`branch`、`remove` 是三个独立 Git 写动作，分别核对当前用户授权并追加
`--user-approved`。默认创建 detached worktree；只有提交需要且分支名明确时才运行 `branch`。

禁止自动 stash、patch 搬运、force remove、prune、reset 或删除分支。目标文件已有未提交改动时
停止创建；不相关脏改动只记录。删除前要求 worktree 干净；detached HEAD 偏离基线时必须先创建
分支；存在 ignored 文件时同样阻止删除。任务完成只提示清理，不自动执行。

绑定显示 `missing` 且路径和 Git 注册都已不存在时，重新获得 `remove` 授权后只清理本机陈旧
绑定；路径或 Git 注册仍有一方存在时停止，不隐式执行 prune 或删除目录。

逻辑仓库、基线 commit 和 checkout mode 记录到任务 `Worktree Binding`；本机绝对路径只写入
忽略的 `.agent-workflow/runtime/worktrees/<task-id>.json`。恢复任务时先用 `status` 核对实际状态，
不得把其他机器上的路径当作可移植事实。
