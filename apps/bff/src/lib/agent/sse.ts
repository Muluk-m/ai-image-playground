import {
  AGENT_SSE_HEARTBEAT_MS,
  agentHeartbeatFrame,
  encodeAgentFrame,
} from '@image-playground/shared'
import type { StoredAgentEvent } from './events'

/**
 * 帧的 id 是轮事件表里的会话内序号，重连带着它回来续播。
 * 静默超过心跳间隔就补一个注释帧：Cloudflare 边缘对久无字节的响应会判读超时。
 */
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
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      // 反代默认按响应缓冲，逐字流会被攒成一坨。
      'x-accel-buffering': 'no',
    },
  })
}

/** 已经结束的轮：尾巴一次性发完就收流。 */
export function agentReplayStream(events: readonly StoredAgentEvent[]): Response {
  return agentTurnStream(
    (async function* () {
      yield* events
    })(),
  )
}
