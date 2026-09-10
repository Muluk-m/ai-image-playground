import {
  AGENT_SSE_HEARTBEAT_MS,
  agentHeartbeatFrame,
  encodeAgentFrame,
} from '@image-playground/shared'
import type { StoredAgentEvent } from './events'

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  // 反代默认按响应缓冲，逐字流会被攒成一坨。
  'x-accel-buffering': 'no',
}

/** 静默超过心跳间隔就补一个注释帧。 */
export function agentTurnStream(
  events: AsyncGenerator<StoredAgentEvent>,
  heartbeatMs = AGENT_SSE_HEARTBEAT_MS,
): Response {
  const encoder = new TextEncoder()
  let pending: Promise<IteratorResult<StoredAgentEvent>> | null = null
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pending ??= events.next()
      let timer: ReturnType<typeof setTimeout> | undefined
      const heartbeat = new Promise<'heartbeat'>((resolve) => {
        timer = setTimeout(() => resolve('heartbeat'), heartbeatMs)
      })
      const next = await Promise.race([pending, heartbeat])
      clearTimeout(timer)
      if (next === 'heartbeat') {
        controller.enqueue(encoder.encode(agentHeartbeatFrame()))
        return
      }
      pending = null
      if (next.done) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(encodeAgentFrame(next.value.seq, next.value.event)))
    },
    async cancel() {
      await events.return(undefined)
    },
  })
  return new Response(body, { headers: SSE_HEADERS })
}

/** 已经结束的轮：尾巴都在内存里，一次发完，不必走心跳那条路。 */
export function agentReplayStream(events: readonly StoredAgentEvent[]): Response {
  const payload = events.map((one) => encodeAgentFrame(one.seq, one.event)).join('')
  return new Response(payload, { headers: SSE_HEADERS })
}
