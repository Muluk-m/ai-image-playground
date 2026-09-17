import { AGENT_TURN_EVENT_RETENTION_MS, type AgentTurnEvent } from '@image-playground/shared'
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { log } from '../logger'

/** 落库攒批的窗口。进程被强杀时最多丢这么久的事件，实时那条路走内存缓冲不受影响。 */
const PERSIST_DEBOUNCE_MS = 50

export interface StoredAgentEvent {
  readonly seq: number
  readonly event: AgentTurnEvent
}

/**
 * 一轮的写入把手。序号由日志自己发，攒批落库也由它自己做；调用方只管 `emit`。
 */
export interface TurnEventLog {
  emit(event: AgentTurnEvent): void
  /** 本轮跑着时的实时流；断开重开都从给定断点续。 */
  read(afterSeq: number): AsyncGenerator<StoredAgentEvent>
  /** 把攒着的事件写完。 */
  flush(): Promise<void>
  /** 收流前必须先 flush，否则消费者会先于落库看到轮结束、重连读到半截。 */
  close(): void
}

/**
 * 读一轮事件的判别结果：在跑的轮给实时流，跑完的轮给表里的重放，
 * 从没有过事件的轮才是「没这一轮」。
 */
export type TurnEventFeed =
  | { readonly kind: 'live'; readonly events: AsyncGenerator<StoredAgentEvent> }
  | { readonly kind: 'replay'; readonly events: readonly StoredAgentEvent[] }
  | { readonly kind: 'no-such-turn' }

/**
 * 进程内还开着的轮日志。读路径据此分流，不去问在跑的轮注册表——注册表管的是
 * 中止与插话那套把手，事件读写只需要知道「这一轮的日志还在不在」。
 */
const openLogs = new Map<string, TurnEventLog>()

/** 会话 id 是 uuid，不含斜杠，所以拼起来不会跟别的会话撞上。 */
function logKey(conversationId: string, turnId: string): string {
  return `${conversationId}/${turnId}`
}

/** 新一轮的序号从这里往后发；序号是会话内的，也就是前端看到的 `Last-Event-ID`。 */
async function lastConversationEventSeq(conversationId: string): Promise<number> {
  const [row] = await db
    .select({ seq: schema.agent_turn_events.seq })
    .from(schema.agent_turn_events)
    .where(eq(schema.agent_turn_events.conversation_id, conversationId))
    .orderBy(desc(schema.agent_turn_events.seq))
    .limit(1)
  return row?.seq ?? 0
}

/** 只问「有没有」：断点追平时不必把整轮的 jsonb 拉回来数长度。 */
async function storedTurnHasEvents(conversationId: string, turnId: string): Promise<boolean> {
  const [row] = await db
    .select({ seq: schema.agent_turn_events.seq })
    .from(schema.agent_turn_events)
    .where(
      and(
        eq(schema.agent_turn_events.conversation_id, conversationId),
        eq(schema.agent_turn_events.turn_id, turnId),
      ),
    )
    .limit(1)
  return row !== undefined
}

async function readStoredTurnEvents(
  conversationId: string,
  turnId: string,
  afterSeq: number,
): Promise<StoredAgentEvent[]> {
  const rows = await db
    .select({ seq: schema.agent_turn_events.seq, event: schema.agent_turn_events.event })
    .from(schema.agent_turn_events)
    .where(
      and(
        eq(schema.agent_turn_events.conversation_id, conversationId),
        eq(schema.agent_turn_events.turn_id, turnId),
        gt(schema.agent_turn_events.seq, afterSeq),
      ),
    )
    .orderBy(asc(schema.agent_turn_events.seq))
  return rows
}

/** 攒批落库的那一下；`now` 只给保留窗口的用例倒时间用。 */
export async function appendAgentTurnEvents(
  conversationId: string,
  turnId: string,
  events: readonly StoredAgentEvent[],
  now = Date.now(),
): Promise<void> {
  if (events.length === 0) return
  await db.insert(schema.agent_turn_events).values(
    events.map((stored) => ({
      conversation_id: conversationId,
      seq: stored.seq,
      turn_id: turnId,
      event: stored.event,
      created_at: now,
    })),
  )
}

/**
 * 开一轮的事件日志：基线序号自己去表里取，事件即产即落库，序号在内存里发，
 * 攒批写以免每个字都付一次数据库往返。开着的日志同时是读路径认得的实时流。
 */
export async function openTurnEventLog(
  conversationId: string,
  turnId: string,
): Promise<TurnEventLog> {
  const baseSeq = await lastConversationEventSeq(conversationId)
  const buffered: StoredAgentEvent[] = []
  const waiting = new Set<() => void>()
  let closed = false
  let persisted = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let writes: Promise<void> = Promise.resolve()

  const persist = () => {
    timer = undefined
    writes = writes.then(async () => {
      const batch = buffered.slice(persisted)
      if (batch.length === 0) return
      persisted = buffered.length
      try {
        await appendAgentTurnEvents(conversationId, turnId, batch)
      } catch (err) {
        log.warn({ event: 'agent.event_persist_failed', turnId, err }, 'turn events not stored')
      }
    })
  }

  const entry: TurnEventLog = {
    emit(event) {
      buffered.push({ seq: baseSeq + buffered.length + 1, event })
      timer ??= setTimeout(persist, PERSIST_DEBOUNCE_MS)
      for (const resolve of waiting) resolve()
      waiting.clear()
    },

    async *read(afterSeq) {
      let index = Math.max(afterSeq - baseSeq, 0)
      while (true) {
        while (index < buffered.length) yield buffered[index++]!
        if (closed) return
        await new Promise<void>((resolve) => waiting.add(resolve))
      }
    },

    async flush() {
      if (timer) clearTimeout(timer)
      persist()
      await writes
    },

    close() {
      closed = true
      const key = logKey(conversationId, turnId)
      if (openLogs.get(key) === entry) openLogs.delete(key)
      for (const resolve of waiting) resolve()
      waiting.clear()
    },
  }

  openLogs.set(logKey(conversationId, turnId), entry)
  return entry
}

/** 读一轮从 `afterSeq` 起的事件，并判断这一轮到底存不存在。 */
export async function readTurnEvents(
  conversationId: string,
  turnId: string,
  afterSeq: number,
): Promise<TurnEventFeed> {
  const live = openLogs.get(logKey(conversationId, turnId))
  if (live) return { kind: 'live', events: live.read(afterSeq) }

  const stored = await readStoredTurnEvents(conversationId, turnId, afterSeq)
  // 断点之后没有新事件不代表轮不存在；只有整轮都查不到才是没这一轮。
  if (stored.length === 0 && !(await storedTurnHasEvents(conversationId, turnId))) {
    return { kind: 'no-such-turn' }
  }
  return { kind: 'replay', events: stored }
}

/** 保留窗口之外的事件没人再续播，留着只会把表撑大。 */
export async function purgeOldAgentTurnEvents(
  retentionMs = AGENT_TURN_EVENT_RETENTION_MS,
  now = Date.now(),
): Promise<number> {
  const removed = await db
    .delete(schema.agent_turn_events)
    .where(lt(schema.agent_turn_events.created_at, now - retentionMs))
    .returning({ seq: schema.agent_turn_events.seq })
  return removed.length
}
