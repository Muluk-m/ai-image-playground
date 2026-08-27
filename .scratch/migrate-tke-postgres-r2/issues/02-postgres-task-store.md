# 02 — 队列元数据上 Postgres

**What to build:** 纯文本生图的队列任务和日配额住在 Postgres 里（测试用 PGlite）。访客可以 submit、轮询、取消、刷新后恢复；配额与幂等仍生效。完成时允许还没有像素对象。BFF 与 worker 同时启动时迁移只跑一次。

**Blocked by:** 01 — Prefactor：异步 Task store + Pixel store 缝

**Status:** done

- [x] 文本-only submit 返回 queued，worker 能 claim 并走到终态
- [x] 同一 client_request_id 复用原队列任务，不重复扣日配额
- [x] 日配额超额返回 429，且扣配额与建任务同事务
- [x] worker 重启把残留 in_progress 标成 interrupted，不自动再打上游
- [x] 取消把库状态改掉后，worker 能观察到
- [x] 运行中的 Task store 不再接受 sqlite 文件路径；测试走 PGlite
- [x] 迁移可重复执行，双进程启动不会把 schema 跑坏
