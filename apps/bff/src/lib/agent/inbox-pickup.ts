import { and, eq, exists, gt, isNull, ne, not } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { bffDrain } from '../drain'
import { log } from '../logger'
import { AGENT_EXECUTION_LEASE_MS } from './execution'
import { drainConversationInbox } from './start-turn'

/**
 * 接手没人处理的排队消息。排队消息平时由当前回复收尾的那个实例接着取；取不到的有两种：
 * 那个实例正在下线（滚动发布时旧版本只收尾、不再开新轮，见 ADR 0009），或者它半路没了。
 * 这时会话没有活着的执行租约、收件箱里却还有待处理的消息——由仍在接新活的实例来取。
 */

const inbox = schema.agent_inbox
const executions = schema.agent_executions
const conversations = schema.agent_conversations

/** 一次最多接手这么多个会话；剩下的下一次再接。 */
const PICKUP_BATCH = 50
/** 巡一次的间隔：旧实例收尾放手后，排着的下一条最迟隔这么久在新版本上开轮。 */
export const AGENT_INBOX_PICKUP_INTERVAL_MS = 5_000

/** 收件箱里有待处理的用户消息、却没有活着的执行租约的会话。 */
export async function strandedInboxConversations(limit = PICKUP_BATCH): Promise<string[]> {
  const leased = db
    .select({ one: executions.conversation_id })
    .from(executions)
    .where(
      and(
        eq(executions.conversation_id, inbox.conversation_id),
        eq(executions.state, 'running'),
        gt(executions.heartbeat_at, Date.now() - AGENT_EXECUTION_LEASE_MS),
      ),
    )
  const rows = await db
    .selectDistinct({ id: inbox.conversation_id })
    .from(inbox)
    .innerJoin(conversations, eq(conversations.id, inbox.conversation_id))
    .where(
      and(
        eq(inbox.kind, 'user_message'),
        eq(inbox.status, 'pending'),
        isNull(conversations.deleted_at),
        not(exists(leased)),
        // 还归旧二进制管的会话由它自己收尾；新版本不去抢（见 `forwardActiveTurn`）。
        config.execution.legacyOrigin ? ne(conversations.runtime_generation, 0) : undefined,
      ),
    )
    .limit(limit)
  return rows.map((row) => row.id)
}

/** 巡一次：每个没人处理的会话各取一条开轮。本实例正在下线就不接。返回开了轮的会话数。 */
export async function pickUpStrandedInboxes(): Promise<number> {
  if (bffDrain.status().draining) return 0
  let started = 0
  for (const conversationId of await strandedInboxConversations()) {
    try {
      const result = await drainConversationInbox(conversationId)
      if (result.kind === 'started') started += 1
    } catch (err) {
      log.error(
        { event: 'agent.inbox_pickup_failed', conversationId, err },
        'stranded queued agent message could not start a turn',
      )
    }
  }
  return started
}

/** 开机先巡一次，之后按间隔巡。返回停止函数。 */
export function startInboxPickup(intervalMs = AGENT_INBOX_PICKUP_INTERVAL_MS): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const started = await pickUpStrandedInboxes()
      if (started > 0)
        log.info({ event: 'agent.inbox_picked_up', started }, 'picked up stranded queued messages')
    } catch (err) {
      log.error({ event: 'agent.inbox_pickup_failed', err }, 'inbox pickup scan failed')
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  return () => clearInterval(timer)
}
