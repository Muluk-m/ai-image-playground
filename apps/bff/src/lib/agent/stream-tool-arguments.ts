import { createParser } from 'eventsource-parser'
import { log } from '../logger'
import type { AgentFetch } from './model'

/** 与模型输出预算独立的流解析保护；正文不占工具参数额度。 */
export const AGENT_TOOL_ARGUMENT_CHARS_PER_TOKEN = 6
export const AGENT_SSE_LINE_MAX_CHARS = 1_048_576
const MAX_ARGUMENT_DEPTH = 64

export class AgentToolArgumentsTooLargeError extends Error {
  constructor(readonly maxChars: number) {
    super(`Model streamed more than ${maxChars} characters of tool-call arguments or SSE data`)
    this.name = 'AgentToolArgumentsTooLargeError'
  }
}

interface ToolDelta {
  index?: number
  function?: { arguments?: string }
  custom?: { input?: string }
}

interface ChatChunk {
  id?: string
  choices?: Array<{ index?: number; delta?: { tool_calls?: ToolDelta[] } }>
}

interface BufferedArguments {
  choice: number
  index: number
  custom: boolean
  pieces: string[]
  depth: number
  quoted: boolean
  escaped: boolean
}

/** 跨增量跟踪 JSON 字符串与括号；字符串内的括号不计深度，不递归解析半成品。 */
function checkDepth(state: BufferedArguments, piece: string): void {
  if (state.custom) return
  for (const char of piece) {
    if (state.quoted) {
      if (state.escaped) state.escaped = false
      else if (char === '\\') state.escaped = true
      else if (char === '"') state.quoted = false
    } else if (char === '"') state.quoted = true
    else if (char === '{' || char === '[') {
      state.depth += 1
      if (state.depth > MAX_ARGUMENT_DEPTH)
        throw new Error(`Model tool-call arguments exceed nesting limit ${MAX_ARGUMENT_DEPTH}`)
    } else if (char === '}' || char === ']') state.depth = Math.max(0, state.depth - 1)
  }
}

/**
 * pi 每个参数增量都会重解析累计 JSON。先线性收集有界参数，流结束时一次交给 SDK，
 * 避免合法长参数和失控流的 O(n²) 开销。正文、推理、工具名称及用量仍即时透传；
 * BFF 本就只在 message_end 后执行工具，不消费不完整的 toolcall_delta 参数。
 */
export function withToolArgumentLimit(fetchFn: AgentFetch, maxChars: number): AgentFetch {
  return async (input, init) => {
    const response = await fetchFn(input, init)
    if (!response.body || !response.ok) return response
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const argumentsByCall = new Map<string, BufferedArguments>()
    const choiceOrder = new Set<number>()
    let total = 0
    let responseId: string | undefined
    let finished = false
    let output: TransformStreamDefaultController<Uint8Array>
    const emit = (data: string, event?: string) => {
      output.enqueue(
        encoder.encode(
          `${event ? `event: ${event}\n` : ''}${data
            .split('\n')
            .map((line) => `data: ${line}`)
            .join('\n')}\n\n`,
        ),
      )
    }
    const flushArguments = () => {
      const choices = new Map<number, ToolDelta[]>()
      for (const state of argumentsByCall.values()) {
        const value = state.pieces.join('')
        const call: ToolDelta = state.custom
          ? { index: state.index, custom: { input: value } }
          : { index: state.index, function: { arguments: value } }
        const calls = choices.get(state.choice) ?? []
        calls.push(call)
        choices.set(state.choice, calls)
      }
      if (choices.size)
        emit(
          JSON.stringify({
            id: responseId,
            choices: [...choiceOrder].map((index) => ({
              index,
              delta: { tool_calls: choices.get(index) ?? [] },
            })),
          }),
        )
      argumentsByCall.clear()
    }
    const parser = createParser({
      maxBufferSize: AGENT_SSE_LINE_MAX_CHARS,
      onError(error) {
        if (error.type === 'max-buffer-size-exceeded')
          throw new AgentToolArgumentsTooLargeError(AGENT_SSE_LINE_MAX_CHARS)
      },
      onEvent(event) {
        if (finished) return
        if (event.data.length > AGENT_SSE_LINE_MAX_CHARS)
          throw new AgentToolArgumentsTooLargeError(AGENT_SSE_LINE_MAX_CHARS)
        if (event.data === '[DONE]') {
          flushArguments()
          finished = true
          emit(event.data, event.event)
          return
        }
        let chunk: ChatChunk
        try {
          chunk = JSON.parse(event.data)
        } catch {
          emit(event.data, event.event)
          return
        }
        if (!chunk || !Array.isArray(chunk.choices)) {
          emit(event.data, event.event)
          return
        }
        responseId ??= chunk.id
        let changed = false
        for (const choice of chunk.choices) {
          choiceOrder.add(choice?.index ?? 0)
          if (!Array.isArray(choice?.delta?.tool_calls)) continue
          for (const call of choice.delta.tool_calls) {
            const piece = call.function?.arguments ?? call.custom?.input
            if (typeof piece !== 'string' || !piece) continue
            total += piece.length
            if (total > maxChars) throw new AgentToolArgumentsTooLargeError(maxChars)
            const key = `${choice.index ?? 0}:${call.index ?? 0}`
            let state = argumentsByCall.get(key)
            if (!state) {
              state = {
                choice: choice.index ?? 0,
                index: call.index ?? 0,
                custom: !call.function,
                pieces: [],
                depth: 0,
                quoted: false,
                escaped: false,
              }
              argumentsByCall.set(key, state)
            }
            checkDepth(state, piece)
            state.pieces.push(piece)
            if (call.function) delete call.function.arguments
            if (call.custom) delete call.custom.input
            changed = true
          }
        }
        emit(changed ? JSON.stringify(chunk) : event.data, event.event)
      },
    })
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          output = controller
          try {
            // 限制每次 feed 的工作量，也让跨行但未收尾的 SSE 事件及时触发缓冲上限。
            for (let start = 0; start < chunk.length; start += 16_384)
              parser.feed(decoder.decode(chunk.subarray(start, start + 16_384), { stream: true }))
          } catch (error) {
            log.warn(
              { event: 'agent.tool_arguments_rejected', maxChars, err: error },
              'rejected unsafe model tool arguments',
            )
            throw error
          }
        },
        flush(controller) {
          output = controller
          parser.feed(decoder.decode())
          // 与 SSE/SDK 保持一致：没有空行收尾的事件不交付；已收到的参数仍须保留。
          flushArguments()
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
