# Portable Resume Card

自然语言“继续上次任务”由 Agent 调用 `agent-workflow task continue`，自动选择任务并加载本卡及摘要；会话已知 ID 时附 `--task`。入口已完成的读取无需重复，核对后继续实际工作。该入口不自动解除 blocked，不等同于生命周期的 `task resume`。
使用 Packet 中的交接能力。先运行 `agent-workflow task summary --task <task-id>`，读取当前状态、交接说明和验证摘要；不要重读全部历史产物。
有 `handoff-state.json` 时运行 `agent-workflow task handoff-check --task <task-id>`，先处理过期或冲突；旧文档没有新鲜度基线，先核对其来源。
摘要列出的 Deferred Context 按 `--section <file>#<section>` 读取，尤其不能跳过被延后的授权、阻塞、下一动作和验证信息。

核对实际仓库状态。有 `in_progress/blocked` 先处理 Current Stage，否则取首个 pending。随后生成对应实际 Route Packet；不继承未落盘的验证结论或 Git 授权。
