import type { AgentTurnEvent } from '@image-playground/shared'
import { log } from '../logger'
import { appendAgentTurnEvents, type StoredAgentEvent } from './events'

/**
 * 一轮在 API 进程里的把手。轮独立于连接存活：消费者断开只是不再拉这个生成器，
 * 轮照跑，重连从事件表或这里的缓冲续上。
 */
export interface RunningTurn {
  readonly conversationId: string
  readonly turnId: string
  read(afterSeq: number): AsyncGenerator<StoredAgentEvent>
  /** 返回插话那条用户消息的 id；它也随 `interjection` 事件发给所有连着的消费者。 */
  interject(text: string): string
  abort(): void
}

const running = new Map<string, RunningTurn>()

/** 一个会话同时只允许一轮，起第二轮的请求由路由挡在门口。 */
export function runningTurn(conversationId: string): RunningTurn | undefined {
  return running.get(conversationId)
}

export function registerRunningTurn(turn: RunningTurn): () => void {
  running.set(turn.conversationId, turn)
  return () => {
    if (running.get(turn.conversationId) === turn) running.delete(turn.conversationId)
  }
}

export interface TurnEventLog {
  emit(event: AgentTurnEvent): void
  read(afterSeq: number): AsyncGenerator<StoredAgentEvent>
  /** 终帧落库之后才收流：此后到达的重连走事件表，读到的必须是完整的一轮。 */
  close(): Promise<void>
}

/**
 * 事件即产即落库，序号在内存里发。落库排在一条串行链上而不是逐条 await，
 * 否则每个字都要等一次数据库往返。
 */
export function turnEventLog(
  conversationId: string,
  turnId: string,
  baseSeq: number,
): TurnEventLog {
  const buffered: StoredAgentEvent[] = []
  const waiting = new Set<() => void>()
  let seq = baseSeq
  let closed = false
  let pending: StoredAgentEvent[] = []
  let writes: Promise<void> = Promise.resolve()

  const wake = () => {
    for (const resolve of waiting) resolve()
    waiting.clear()
  }

  return {
    emit(event) {
      seq += 1
      const stored = { seq, event }
      buffered.push(stored)
      pending.push(stored)
      writes = writes.then(async () => {
        if (pending.length === 0) return
        const batch = pending
        pending = []
        try {
          await appendAgentTurnEvents(conversationId, turnId, batch)
        } catch (err) {
          log.warn({ event: 'agent.event_persist_failed', turnId, err }, 'turn event not stored')
        }
      })
      wake()
    },

    async *read(afterSeq) {
      let cursor = Math.max(afterSeq, baseSeq)
      while (true) {
        for (const stored of buffered.slice(cursor - baseSeq)) {
          cursor = stored.seq
          yield stored
        }
        if (closed) return
        await new Promise<void>((resolve) => waiting.add(resolve))
      }
    },

    async close() {
      closed = true
      wake()
      await writes
    },
  }
}
