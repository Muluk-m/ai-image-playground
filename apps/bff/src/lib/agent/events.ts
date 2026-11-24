import {
  appendAgentTurnEvents,
  lastConversationEventSeq,
  notifyConversation,
  openTurnEventBase,
  openTurnEventLog,
  purgeOldAgentTurnEvents,
  readConversationEvents,
  readTurnEvents,
  recoverAbandonedExecution,
  registerInterruptedTurnRecoverer,
  sealAbandonedTurns,
} from '../../modules/agent'
import {
  isSealLease,
  SEAL_SEQ_GAP,
  type StoredAgentEvent,
  type TurnEventFeed,
  type TurnEventLog,
} from '../../modules/agent/contracts'

// 兼容未经过 `app.ts` 组合根启动的单测（如 `events.test.ts`）：按需惰性注册默认恢复器。
registerInterruptedTurnRecoverer((conversationId, turnId) =>
  import('./interrupted').then((it) => it.recoverInterruptedTurn(conversationId, turnId)),
)

export {
  appendAgentTurnEvents,
  isSealLease,
  lastConversationEventSeq,
  notifyConversation,
  openTurnEventBase,
  openTurnEventLog,
  purgeOldAgentTurnEvents,
  readConversationEvents,
  readTurnEvents,
  recoverAbandonedExecution,
  SEAL_SEQ_GAP,
  type StoredAgentEvent,
  sealAbandonedTurns,
  type TurnEventFeed,
  type TurnEventLog,
}
