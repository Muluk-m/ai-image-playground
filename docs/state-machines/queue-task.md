# 队列任务 `tasks.status`

库存状态与 [queue-protocol](../../packages/shared/src/queue-protocol.ts) 的 `TASK_STATUSES` 相同。转移表：`packages/shared/src/machines/queue-task.ts`。

```mermaid
stateDiagram-v2
  [*] --> queued: 提交生图或生视频
  [*] --> in_progress: 对话轮占用行直接插入
  queued --> in_progress: claim
  queued --> cancelled: cancel
  in_progress --> queued: retry / resume_poll / retry_archive
  in_progress --> reconciling: reconcile
  in_progress --> completed: succeed
  in_progress --> failed: fail
  in_progress --> cancelled: cancel
  queued --> reconciling: reconcile
  reconciling --> completed: succeed
  reconciling --> failed: fail
  reconciling --> cancelled: cancel
  reconciling --> in_progress: resume
```

生图取消只发生在 `queued` 和 `in_progress`。已经派出的分析任务从这两个状态进入 `reconciling`，不退款。零派发的分析核查会从 `reconciling` 写成 `cancelled`。人工确认分析核查时先 `resume` 回 `in_progress` 再结算。

CLI 不暴露这六态。`projectCliJobStatus` 把 `completed` 映成 `succeeded`，`cancelled` 映成 `canceled`，进度阶段 `confirming` 映成 `persisting`，`reconciling` 仍是 `running`。

```mermaid
stateDiagram-v2
  queued --> running: 阶段不是 queued
  queued --> persisting: 阶段 confirming
  running --> persisting: 阶段 confirming
  running --> succeeded: 任务 completed
  running --> failed
  running --> canceled
  persisting --> succeeded
  persisting --> failed
```

结算函数里的写入还没有改成 `step`，见 [INVENTORY](INVENTORY.md) 的提案。认领（`queued → in_progress`）在后续 PR 接到 worker。
