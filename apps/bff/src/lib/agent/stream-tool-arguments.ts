import { log } from '../logger'
import type { AgentFetch } from './model'

/** 每个输出 token 最多按这么多字符算；超出说明网关没执行 max_tokens，模型在失控地吐参数。 */
export const AGENT_TOOL_ARGUMENT_CHARS_PER_TOKEN = 6

export class AgentToolArgumentsTooLargeError extends Error {
  constructor(readonly maxChars: number) {
    super(`Model streamed more than ${maxChars} characters of tool-call arguments`)
    this.name = 'AgentToolArgumentsTooLargeError'
  }
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      tool_calls?: Array<{ function?: { arguments?: unknown }; custom?: { input?: unknown } }>
    }
  }>
}

function argumentChars(payload: string): number {
  let chunk: ChatChunk
  try {
    chunk = JSON.parse(payload)
  } catch {
    return 0
  }
  let chars = 0
  for (const choice of chunk.choices ?? [])
    for (const call of choice.delta?.tool_calls ?? []) {
      const piece = call.function?.arguments ?? call.custom?.input
      if (typeof piece === 'string') chars += piece.length
    }
  return chars
}

/**
 * 给 Chat Completions 流的工具参数总长设上限。pi 每收到一个参数增量都把累计的整串重新解析
 * 一遍，失控的工具调用因此是 O(n²) 的 CPU，会把 BFF 主线程拖死（2026-10-24 paid 事故）。
 * 这里只线性扫一遍 SSE，越线就让流报错并取消上游。
 */
export function withToolArgumentLimit(fetchFn: AgentFetch, maxChars: number): AgentFetch {
  return async (input, init) => {
    const response = await fetchFn(input, init)
    if (!response.body) return response
    const decoder = new TextDecoder()
    let pending = ''
    let total = 0
    /** 越线时让流报错并返回 false，这一块不再往下游送。 */
    const scan = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        total += argumentChars(line.slice(5).trim())
        if (total > maxChars) {
          log.warn(
            { event: 'agent.tool_arguments_too_large', maxChars },
            'model streamed oversized tool-call arguments',
          )
          controller.error(new AgentToolArgumentsTooLargeError(maxChars))
          return false
        }
      }
      return true
    }
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (scan(decoder.decode(chunk, { stream: true }), controller)) controller.enqueue(chunk)
        },
        flush(controller) {
          scan(`${decoder.decode()}\n`, controller)
        },
      }),
    )
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
