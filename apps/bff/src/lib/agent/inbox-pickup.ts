import {
  AGENT_INBOX_PICKUP_INTERVAL_MS,
  abandonedExecutions,
  type InboxPickupHandlers,
  pickUpStrandedInboxesWith,
  startInboxPickupWith,
  strandedInboxConversations,
} from '../../modules/agent'
import { recoverAbandonedExecution } from './events'
import { drainConversationInbox } from './start-turn'

export { AGENT_INBOX_PICKUP_INTERVAL_MS, abandonedExecutions, strandedInboxConversations }

const defaultHandlers: InboxPickupHandlers = {
  recoverAbandonedExecution,
  drainConversationInbox,
}

/** 绑定运行层恢复与开轮处理器后的默认巡查入口（过渡封装，PR-4.3 迁入 runtime 组合）。 */
export function pickUpStrandedInboxes(now = Date.now()): Promise<number> {
  return pickUpStrandedInboxesWith(defaultHandlers, now)
}

/** 绑定运行层恢复与开轮处理器后的默认周期巡查入口。 */
export function startInboxPickup(intervalMs = AGENT_INBOX_PICKUP_INTERVAL_MS): () => void {
  return startInboxPickupWith(defaultHandlers, intervalMs)
}
