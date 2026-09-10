import type { AgentTurnEvent } from '@image-playground/shared'
import { log } from '../logger'
import { appendAgentTurnEvents, type StoredAgentEvent } from './events'

/** 落库攒批的窗口。进程被强杀时最多丢这么久的事件，实时那条路走内存缓冲不受影响。 */
const PERSIST_DEBOUNCE_MS = 50

/**
 * 一轮在 API 进程里的把手。轮独立于连接存活，只有跑完、失败或显式中止才结束。
 * 注册表是进程内的：BFF 多副本时续播会落到没有这一轮的进程上。
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
  /** 把攒着的事件写完。 */
  flush(): Promise<void>
  /** 收流前必须先 flush 并摘掉注册，否则消费者会先于落库看到轮结束、重连读到半截。 */
  close(): void
}

/** 事件即产即落库，序号在内存里发，攒批写以免每个字都付一次数据库往返。 */
export function turnEventLog(
  conversationId: string,
  turnId: string,
  baseSeq: number,
): TurnEventLog {
  const buffered: StoredAgentEvent[] = []
  const waiting = new Set<() => void>()
  let closed = false
  let persisted = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let writes: Promise<void> = Promise.resolve()

  const flush = () => {
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

  return {
    emit(event) {
      buffered.push({ seq: baseSeq + buffered.length + 1, event })
      timer ??= setTimeout(flush, PERSIST_DEBOUNCE_MS)
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
      flush()
      await writes
    },

    close() {
      closed = true
      for (const resolve of waiting) resolve()
      waiting.clear()
    },
  }
}
