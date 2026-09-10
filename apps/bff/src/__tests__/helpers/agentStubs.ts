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
  readonly tools?: { function: { name: string } }[]
  readonly stream_options?: { include_usage?: boolean }
}

interface CompletionUsage {
  readonly prompt_tokens: number
  readonly completion_tokens: number
}

const REPORTED_USAGE: CompletionUsage = { prompt_tokens: 12, completion_tokens: 4 }

interface CompletionOptions {
  readonly deltas: readonly string[]
  /** 缺席即模拟「中转网关吞掉 stream_options」：末帧不带用量。 */
  readonly usage?: CompletionUsage
}

/** 上游把一条回复拆成若干 delta，末帧带 finish_reason —— 逐字流的最小可信形状。 */
export function completionStream(...deltas: string[]): Response {
  return completion({ deltas, usage: REPORTED_USAGE })
}

export function completion({ deltas, usage }: CompletionOptions): Response {
  const stream = controlledCompletion(usage ?? null)
  for (const delta of deltas) stream.push(delta)
  stream.finish()
  return stream.responseFor()
}

export interface ToolCallSpec {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
}

/** 上游要求调工具的那一条回复。一条消息里可以有多个调用，各占一个 `index`。 */
export function toolCallCompletion(...calls: ToolCallSpec[]): Response {
  const stream = controlledCompletion()
  for (const [index, call] of calls.entries()) stream.pushToolCall(index, call)
  stream.finish()
  return stream.responseFor()
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
      tools: sent.tools,
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
  push(content: string): void
  pushToolCall(index: number, call: ToolCallSpec): void
  finish(): void
}

/** 上游流由测试逐段驱动：断线续播、中止与插话都要求这一轮在断言期间保持进行中。 */
export function controlledCompletion(
  usage: CompletionUsage | null = REPORTED_USAGE,
): ControlledCompletion {
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
    pushToolCall(index, call) {
      // 参数分两帧发：上游本来就是逐段吐 arguments，一帧发完测不到拼接。
      const [head, tail] = splitArguments(call.args)
      send({
        id: 'completion-1',
        choices: [
          {
            index: 0,
            delta: {
              ...(started ? {} : { role: 'assistant' }),
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: head },
                },
              ],
            },
          },
        ],
      })
      started = true
      send({
        id: 'completion-1',
        choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: tail } }] } }],
      })
    },
    finish() {
      send({
        id: 'completion-1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ...(usage ? { usage } : {}),
      })
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }
}

function splitArguments(args: Record<string, unknown>): [string, string] {
  const encoded = JSON.stringify(args)
  const at = Math.floor(encoded.length / 2)
  return [encoded.slice(0, at), encoded.slice(at)]
}
