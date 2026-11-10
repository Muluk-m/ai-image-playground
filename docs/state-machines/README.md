# 状态机怎么显式化

不引入 XState 或其他运行时。生命周期用 `packages/shared/src/state-machine.ts` 的 `defineMachine`：一张转移表是状态、事件和下一状态的唯一来源。

- `step(from, event)` 返回下一状态；表里没有这条边就抛 `IllegalTransitionError`，调用方不应写库。
- `allows` 用于沿用现有错误码的守卫（公告、灵感删除）。
- `target(event)` 用于「来源不唯一、但目的地唯一」的写入（取消、回收）。来源仍由原来的 SQL `WHERE` 限定，避免为了读当前状态多一次查询。
- 新建一行（入队、抢先占位、直接插入 `in_progress` 的对话轮）不是转移，用常量标出初始状态。
- 时间派生的视图（公告有效状态、任务进度阶段、CLI 六态）保持纯函数，不写回库存状态。
- 前端只在本包内的上传和对话轮视图使用同一套 `defineMachine`。store 里二十多处分别写 `turn` / `stopping` / `reconnecting` 的，本轮只加视图，不改写入。

计费预扣、结算、退款不改。`apps/bff/src/db/task-transitions.ts` 里的 `finishTask` / `cancelTasks` 与积分结算在同一个函数里，转移表已经描述这些边，接入留在提案里。

每张已落地的表都有单测，图在同目录的 `<name>.md`。
