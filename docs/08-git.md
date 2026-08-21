# Git

Git 阶段的目标是让仓库状态、提交和远端操作可审查、可追踪、可回滚。进入 Git 阶段不代表自动获得写入 Git 历史或远端的授权。

## 授权分层

| 动作 | 默认权限 | 要求 |
|------|----------|------|
| 定位仓库、查看分支、`status`、`diff` | 可执行 | 只读检查，范围限定到当前任务 |
| worktree `plan` / `status` | 可执行 | 只读检查，使用任务 ID 和稳定仓库相对路径 |
| worktree `create` | 不执行 | 用户明确允许目标任务、仓库、基线和目标文件 |
| worktree `branch` | 不执行 | 用户明确允许目标仓库和分支名 |
| worktree `remove` | 不执行 | 用户明确允许目标绑定；必须通过安全删除门禁 |
| `add` / stage | 不执行 | 用户明确要求暂存 |
| `commit` | 不执行 | 用户明确要求提交；提交授权不包含 push |
| `push` | 不执行 | 用户明确允许目标仓库、分支和远端 |
| 创建 PR / 合并 / 发布 | 不执行 | 分别获得明确授权 |

用户只要求实现或修复代码时，默认停在 Git Inspect。

## 多仓库规则

- Git 操作前必须解析每个改动文件所属的仓库根目录。
- 报告中必须记录仓库根目录、工作目录、分支和远端。
- 跨仓库改动按仓库分别检查、分别授权、分别提交，不得用一个提交概括多个仓库。
- 不在仓库归属未确认时执行 `add`、`commit` 或 `push`。
- 任务产物和仓库上下文按 [`12-artifacts.md`](./12-artifacts.md) 记录。

## Worktree 隔离

需要隔离用户已有改动或并行任务时，按手动加载的 [`worktree.md`](../resources/cards/worktree.md)
操作。Active Profile 声明的独立仓库分别绑定；跨仓库任务不得共用一个 worktree 或授权。

- `plan` 只读解析仓库、基线、目标文件状态和目标目录；`create` 至少声明一个目标文件。
- 默认从已解析的 commit 创建 detached worktree；创建分支是后续独立动作。
- 不自动 stash、搬运 patch、force remove、prune、reset 或删除分支。
- 目标文件已有未提交改动时停止；不相关脏改动可以保留，但必须报告。
- 删除前要求工作树干净且没有 ignored 本地文件；detached HEAD 偏离基线时先创建分支保存提交。
- 任务完成不自动删除 worktree；清理仍需重新核对状态和用户授权。

## Git Inspect

至少检查：

```text
git status
git diff
检查是否包含无关文件
检查是否误改生成物、本地配置或用户已有改动
执行项目规则允许的静态检查
```

项目禁止 Agent 运行构建或测试时，不执行 lint/test；把建议命令和未验证项写入 Verify Report。

## Commit Message

推荐格式：

```text
feat(module): 描述新增能力
fix(module): 描述修复问题
docs(scope): 描述文档变更
chore(scope): 描述工程事务
refactor(module): 描述重构
test(module): 描述测试变更
```

示例：

```text
fix(ass): 修复售后策略字段权限校验
docs(workflow): 完善 AI 协作工作流协议
```

## Commit 规则

- 仅在用户明确要求时 stage 和 commit。
- commit 前检查目标仓库的 `status` 和 diff。
- 只包含当前任务文件，不覆盖或夹带用户已有改动。
- 每个仓库单独生成 commit message 和提交结果。

## Push 规则

- 仅在用户明确要求时 push。
- push 前确认目标仓库、当前分支和远端。
- commit 授权不自动包含 push 或创建 PR。
- CI 或远端检查失败时记录结果并停止。

## 输出模板

```md
# Git Report

## Authorization
- Inspect:
- Worktree Create:
- Worktree Branch:
- Worktree Remove:
- Git Stage:
- Commit:
- Push:
- PR:

## Repository: <name>
- Root:
- Working Directory:
- Branch:
- Remote:
- Changed Files:

### Status / Diff

### Static Checks

### Commit

### Push / PR

### Notes
```

跨仓库任务为每个仓库重复 `Repository` 小节。

## 通过标准

- 每个改动文件的仓库归属已明确。
- status 和 diff 已检查。
- 无无关文件进入暂存或提交。
- 实际 Git 动作没有超出用户授权。
- worktree 的创建、分支和删除授权没有相互继承，清理未丢失改动或 detached 提交。
- 如执行了 commit，commit message 符合格式。
- 未执行的 commit、push 或 PR 明确标记为“未授权/未执行”。
