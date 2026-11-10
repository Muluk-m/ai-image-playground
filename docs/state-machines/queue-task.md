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
  reconciling --> completed: succeed
  reconciling --> failed: fail
```

`reconciling` 不能取消、不能直接重试。取消已发出的上游请求时，先进入核查，预扣留在那里。

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
