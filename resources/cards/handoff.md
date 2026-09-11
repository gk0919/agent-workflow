# Task Handoff Card

自然语言“交接当前任务”由 Agent 调用 `agent-workflow task prepare`；会话已知 ID 时附 `--task`。入口已加载本卡时直接处理返回的任务，不重复调用入口。Agent 负责 notes、生成和检查，用户无需填写文件或运行命令。
用户要求换会话、切工具或交接时生成完整交接包；阶段推进仍由 task 命令更新 manifest 的最小检查点。
使用 Packet 的交接能力整理当前任务，调用 `agent-workflow task handoff --task <task-id>`，
再调用 `agent-workflow task handoff-check --task <task-id>`。目标任务 ID 是命令参数，不改变原任务 Route。
恢复前使用 portable-resume。交接包只能记录已有授权的来源和范围，不能授予新权限。
