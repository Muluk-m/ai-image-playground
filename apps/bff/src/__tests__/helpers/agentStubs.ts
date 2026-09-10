import { mock } from 'bun:test'
import type { AgentTurnEvent } from '@image-playground/shared'

export interface AgentCall {
  readonly url: string
  readonly authorization: string | null
  readonly model: string
  readonly messages: { role: string; content: unknown }[]
}

function sseBody(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}

/** 上游把一条回复拆成若干 delta，末帧带 finish_reason —— 逐字流的最小可信形状。 */
export function completionStream(...deltas: string[]): Response {
  const chunks: unknown[] = deltas.map((content, index) => ({
    id: 'completion-1',
    choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content } : { content } }],
  }))
  chunks.push({
    id: 'completion-1',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  })
  return new Response(sseBody(chunks), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

export function recordingAgentFetch(
  calls: AgentCall[],
  answer: () => Response,
): typeof globalThis.fetch {
  return mock(async (input: unknown, init: unknown) => {
    const request = init as { headers?: HeadersInit; body?: string }
    const sent = JSON.parse(String(request.body)) as AgentCall
    calls.push({
      url: String(input),
      authorization: new Headers(request.headers).get('authorization'),
      model: sent.model,
      messages: sent.messages,
    })
    return answer()
  }) as unknown as typeof globalThis.fetch
}

export interface ReceivedFrame {
  readonly id: number
  readonly event: AgentTurnEvent
}

/** 把 SSE 报文拆回 (id, 事件) 序列；断言 id 单调性靠它。 */
export function parseFrames(payload: string): ReceivedFrame[] {
  return payload
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n')
      const id = Number(
        lines
          .find((line) => line.startsWith('id:'))!
          .slice(3)
          .trim(),
      )
      const data = lines
        .find((line) => line.startsWith('data:'))!
        .slice(5)
        .trim()
      return { id, event: JSON.parse(data) as AgentTurnEvent }
    })
}
