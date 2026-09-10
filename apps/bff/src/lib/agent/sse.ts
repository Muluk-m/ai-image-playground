import type { AgentTurnEvent } from '@image-playground/shared'

/** 每帧带会话内单调递增的 id，断线重连据此定位续播点。 */
export function encodeAgentFrame(id: number, event: AgentTurnEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export function agentTurnStream(events: AsyncGenerator<AgentTurnEvent>): Response {
  const encoder = new TextEncoder()
  let id = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next()
      if (next.done) {
        controller.close()
        return
      }
      id += 1
      controller.enqueue(encoder.encode(encodeAgentFrame(id, next.value)))
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
