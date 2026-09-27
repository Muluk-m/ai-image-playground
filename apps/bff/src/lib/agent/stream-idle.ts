import { log } from '../logger'
import type { AgentFetch } from './model'

/** 模型请求连续这么久没有任何动静（响应头或新的数据块）就放弃。 */
export const AGENT_STREAM_IDLE_TIMEOUT_MS = 180_000

export class AgentStreamStalledError extends Error {
  constructor(readonly idleMs: number) {
    super(`Model stream sent nothing for ${idleMs}ms`)
    this.name = 'AgentStreamStalledError'
  }
}

/**
 * 给模型请求套一个空闲看门狗。没有它，网关卡在半路时一轮会一直挂着，会话执行租约也跟着
 * 一直占着，用户在这个会话里什么都做不了。只在等上游的时候计时（等响应头、等下一块），
 * 读的一方慢不算；也不计总时长，长回复只要一直在吐字就不受影响。阈值要宽：推理模型想的
 * 时候网关可能很久不吐字。
 */
export function withIdleTimeout(fetchFn: AgentFetch, idleMs: number): AgentFetch {
  return async (input, init = {}) => {
    const controller = new AbortController()
    const caller = init.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let fail: (reason: unknown) => void = () => {}
    const relay = () => controller.abort(caller?.reason)
    const settle = () => {
      clearTimeout(timer)
      caller?.removeEventListener('abort', relay)
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        log.warn({ event: 'agent.model_stream_stalled', idleMs }, 'model stream stalled')
        controller.abort(new AgentStreamStalledError(idleMs))
      }, idleMs)
    }
    controller.signal.addEventListener('abort', () => fail(controller.signal.reason), {
      once: true,
    })
    if (caller?.aborted) controller.abort(caller.reason)
    else caller?.addEventListener('abort', relay, { once: true })

    arm()
    let response: Response
    try {
      response = await fetchFn(input, { ...init, signal: controller.signal })
    } catch (err) {
      settle()
      throw controller.signal.aborted ? controller.signal.reason : err
    }
    clearTimeout(timer)
    if (!response.body) {
      settle()
      return response
    }
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        // 中止时直接让这一侧的流报错：上游替身或网关未必理会中止信号。
        fail = (reason) => {
          settle()
          stream.error(reason)
          void reader.cancel(reason).catch(() => {})
        }
        if (controller.signal.aborted) fail(controller.signal.reason)
      },
      async pull(stream) {
        try {
          arm()
          const chunk = await reader.read()
          clearTimeout(timer)
          if (controller.signal.aborted) return
          if (chunk.done) {
            settle()
            stream.close()
            return
          }
          stream.enqueue(chunk.value)
        } catch (err) {
          if (controller.signal.aborted) return
          settle()
          stream.error(err)
        }
      },
      cancel(reason) {
        settle()
        return reader.cancel(reason)
      },
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
