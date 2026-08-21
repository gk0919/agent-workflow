# Portable Resume Card

先运行 `npm run workflow:task -- summary --task <task-id>`，只读取 manifest/source/handoff 当前摘要；不要重读全部历史产物。

核对实际仓库状态。有 `in_progress/blocked` 先处理 Current Stage，否则取首个 pending。随后生成对应实际 Route Packet；不继承未落盘的验证结论或 Git 授权。
