import { mock } from 'bun:test'
import {
  AGENT_FRAME_SEPARATOR,
  type AgentTurnEvent,
  parseAgentFrame,
} from '@image-playground/shared'

export interface AgentCall {
  readonly url: string
  readonly authorization: string | null
  readonly model: string
  readonly messages: { role: string; content: unknown }[]
  readonly stream_options?: { include_usage?: boolean }
}

function sseBody(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}

interface CompletionOptions {
  readonly deltas: readonly string[]
  /** 缺席即模拟「中转网关吞掉 stream_options」：末帧不带用量。 */
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number }
}

/** 上游把一条回复拆成若干 delta，末帧带 finish_reason —— 逐字流的最小可信形状。 */
export function completionStream(...deltas: string[]): Response {
  return completion({ deltas, usage: { prompt_tokens: 12, completion_tokens: 4 } })
}

export function completion({ deltas, usage }: CompletionOptions): Response {
  const chunks: unknown[] = deltas.map((content, index) => ({
    id: 'completion-1',
    choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content } : { content } }],
  }))
  chunks.push({
    id: 'completion-1',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  })
  return new Response(sseBody(chunks), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

export function recordingAgentFetch(
  calls: AgentCall[],
  answer: (signal?: AbortSignal) => Response,
): typeof globalThis.fetch {
  return mock(async (input: unknown, init: unknown) => {
    const request = init as { headers?: HeadersInit; body?: string; signal?: AbortSignal }
    const sent = JSON.parse(String(request.body)) as AgentCall
    calls.push({
      url: String(input),
      authorization: new Headers(request.headers).get('authorization'),
      model: sent.model,
      messages: sent.messages,
      stream_options: sent.stream_options,
    })
    return answer(request.signal)
  }) as unknown as typeof globalThis.fetch
}

export interface ReceivedFrame {
  readonly id: number
  readonly event: AgentTurnEvent
}

/** 把 SSE 报文拆回 (id, 事件) 序列；心跳注释没有 data，在这里被丢掉。 */
export function parseFrames(payload: string): ReceivedFrame[] {
  return payload
    .split(AGENT_FRAME_SEPARATOR)
    .filter((block) => block.trim())
    .map((block) => parseAgentFrame(block))
    .filter((frame): frame is { id: number; event: AgentTurnEvent } => frame?.id != null)
}

export interface ControlledCompletion {
  /** 中止要靠 signal 把上游流打断，否则 pi 会一直等这条永不结束的流。 */
  responseFor(signal?: AbortSignal): Response
  /** 追加一段逐字增量。 */
  push(content: string): void
  /** 收尾：带 finish_reason 的末帧 + [DONE]。 */
  finish(): void
}

/**
 * 上游流由测试逐段驱动。轮的生命周期不再绑在消费者身上，断线续播、中止与插话
 * 都要求这一轮在断言期间保持进行中。
 */
export function controlledCompletion(): ControlledCompletion {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  let started = false
  const send = (chunk: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  return {
    responseFor(signal) {
      signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
      return response
    },
    push(content) {
      send({
        id: 'completion-1',
        choices: [{ index: 0, delta: started ? { content } : { role: 'assistant', content } }],
      })
      started = true
    },
    finish() {
      send({
        id: 'completion-1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      })
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }
}
