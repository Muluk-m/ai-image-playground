import {
  AGENT_TURN_EVENT_RETENTION_MS,
  type AgentTurnEndEvent,
  type AgentTurnEvent,
} from '@image-playground/shared'
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { log } from '../logger'
import { claimConversation, releaseConversation } from './execution'

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
  /** 开日志时会话已有的最大序号；本轮第一条事件是它加一。 */
  readonly baseSeq: number
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
export async function lastConversationEventSeq(conversationId: string): Promise<number> {
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
  await db
    .insert(schema.agent_turn_events)
    .values(
      events.map((stored) => ({
        conversation_id: conversationId,
        seq: stored.seq,
        turn_id: turnId,
        event: stored.event,
        created_at: now,
      })),
    )
    .onConflictDoNothing()
}

/**
 * 开一轮的事件日志：基线序号自己去表里取，事件即产即落库，序号在内存里发，
 * 攒批写以免每个字都付一次数据库往返。发出第一条事件起，它就是读路径认得的实时流。
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
    writes = writes
      .catch(() => {})
      .then(async () => {
        const batch = buffered.slice(persisted)
        if (batch.length === 0) return
        await appendAgentTurnEvents(conversationId, turnId, batch)
        persisted += batch.length
      })
    void writes.catch((err) => {
      log.warn(
        { event: 'agent.event_persist_failed', turnId, err },
        'turn events awaiting persistence',
      )
    })
  }

  const entry: TurnEventLog = {
    baseSeq,
    emit(event) {
      // 发了第一条才登记：建轮半路抛错的日志没人会 close，登记了续播就永远等不到头。
      if (buffered.length === 0 && !closed) openLogs.set(logKey(conversationId, turnId), entry)
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

/**
 * 本进程里开着的那一轮日志从哪个序号之后开始。快照据此把游标停在进行中那一轮的 `turnStart`
 * 之前：半截回复还没落库，只能从轮头重放出来。
 */
export function openTurnEventBase(conversationId: string, turnId: string): number | undefined {
  return openLogs.get(logKey(conversationId, turnId))?.baseSeq
}

/** 一个会话同时只有一轮在跑，所以按会话找到的开着的日志至多一份。 */
function openConversationLog(conversationId: string): TurnEventLog | undefined {
  const prefix = `${conversationId}/`
  for (const [key, entry] of openLogs) if (key.startsWith(prefix)) return entry
  return undefined
}

async function readStoredConversationEvents(
  conversationId: string,
  afterSeq: number,
): Promise<StoredAgentEvent[]> {
  return db
    .select({ seq: schema.agent_turn_events.seq, event: schema.agent_turn_events.event })
    .from(schema.agent_turn_events)
    .where(
      and(
        eq(schema.agent_turn_events.conversation_id, conversationId),
        gt(schema.agent_turn_events.seq, afterSeq),
      ),
    )
    .orderBy(asc(schema.agent_turn_events.seq))
}

/**
 * 会话级增量：`afterSeq` 之后的全部事件，不分属于哪一轮，按序号给出。先给表里的，
 * 本进程有轮在跑就接着它的实时流，跑到它收尾为止；两段按序号去重，所以不重不漏。
 * 接着读之前调用方应先 {@link sealAbandonedTurns}，否则被打断的轮永远等不到终帧。
 */
export async function readConversationEvents(
  conversationId: string,
  afterSeq: number,
): Promise<AsyncGenerator<StoredAgentEvent>> {
  // 先拿实时日志再读表：顺序反过来，读表之后才开的轮会整段漏掉，直到下一次重连。
  const live = openConversationLog(conversationId)
  const stored = await readStoredConversationEvents(conversationId, afterSeq)
  return (async function* () {
    let seen = afterSeq
    for (const one of stored) {
      seen = one.seq
      yield one
    }
    if (!live) return
    for await (const one of live.read(seen)) {
      if (one.seq <= seen) continue
      seen = one.seq
      yield one
    }
  })()
}

interface UnterminatedTurn {
  readonly turnId: string
  readonly firstAt: number
  readonly lastAt: number
}

/** 表里有事件、却没有终帧、本进程也没开着它的日志的轮。 */
async function unterminatedTurns(conversationId: string): Promise<UnterminatedTurn[]> {
  const events = schema.agent_turn_events
  const rows = await db
    .select({
      turnId: events.turn_id,
      firstAt: sql<string>`min(${events.created_at})`,
      lastAt: sql<string>`max(${events.created_at})`,
    })
    .from(events)
    .where(eq(events.conversation_id, conversationId))
    .groupBy(events.turn_id)
    .having(sql`bool_and(${events.event}->>'type' <> 'turnEnd')`)
  return rows
    .filter((row) => !openLogs.has(logKey(conversationId, row.turnId)))
    .map((row) => ({
      turnId: row.turnId,
      firstAt: new Date(row.firstAt).getTime(),
      lastAt: new Date(row.lastAt).getTime(),
    }))
}

/**
 * 给没收尾的轮补写终帧。页脚已经落了（进程死在发终帧之前）就照它补，
 * 否则按失败补并把页脚一起落上：刷新后的面板与续播看到的是同一个结局。
 */
async function writeSeals(conversationId: string, turns: readonly UnterminatedTurn[]) {
  for (const turn of turns) {
    const [summary] = await db
      .select()
      .from(schema.agent_turns)
      .where(
        and(
          eq(schema.agent_turns.conversation_id, conversationId),
          eq(schema.agent_turns.turn_id, turn.turnId),
        ),
      )
    const durationMs = summary?.duration_ms ?? Math.max(turn.lastAt - turn.firstAt, 0)
    const event: AgentTurnEndEvent = summary
      ? {
          type: 'turnEnd',
          turnId: turn.turnId,
          durationMs,
          stopReason: summary.stop_reason,
          usage: null,
          ...(summary.cost ? { cost: summary.cost } : {}),
        }
      : {
          type: 'turnEnd',
          turnId: turn.turnId,
          durationMs,
          stopReason: 'failed',
          error: 'agent_run_failed',
          usage: null,
        }
    if (!summary) {
      await db
        .insert(schema.agent_turns)
        .values({
          conversation_id: conversationId,
          turn_id: turn.turnId,
          duration_ms: durationMs,
          stop_reason: 'failed',
          created_at: Date.now(),
        })
        .onConflictDoNothing()
    }
    const seq = (await lastConversationEventSeq(conversationId)) + 1
    await appendAgentTurnEvents(conversationId, turn.turnId, [{ seq, event }])
    log.warn(
      { event: 'agent.turn_sealed', conversationId, turnId: turn.turnId },
      'interrupted turn sealed with a terminal event',
    )
  }
}

/**
 * 服务端补写终帧：进程被杀、租约过期、收尾本身失败的轮没有 `turnEnd`，续播会一直等下去。
 * 写之前领会话租约，与起轮用同一把——在跑的轮（本机或别的实例）占着租约，领不到就什么都不写，
 * 所以补写的序号不会与进行中那一轮的内存序号撞车。`owned` 表示调用方已经持有租约（起轮时）。
 */
export async function sealAbandonedTurns(conversationId: string, owned = false): Promise<void> {
  const found = await unterminatedTurns(conversationId)
  if (found.length === 0) return
  if (owned) {
    await writeSeals(conversationId, found)
    return
  }
  const sealId = `seal:${crypto.randomUUID()}`
  if (!(await claimConversation(conversationId, sealId))) return
  try {
    // 领到之后重查：领之前那一轮可能刚好自己收了尾。
    await writeSeals(conversationId, await unterminatedTurns(conversationId))
  } finally {
    await releaseConversation(conversationId, sealId)
  }
}
