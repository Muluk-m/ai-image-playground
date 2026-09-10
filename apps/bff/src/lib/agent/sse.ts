import { type AgentTurnEvent, encodeAgentFrame } from '@image-playground/shared'

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
