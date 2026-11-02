import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type ThinkingLevel,
} from '@earendil-works/pi-ai'
import { log } from '../logger'

export interface OverloadFallback {
  readonly model: Model<Api>
  readonly stream: StreamFn
  /** 备用模型自己的推理强度；不沿用主模型这一轮的强度。 */
  readonly reasoning: ThinkingLevel | undefined
  /** 这份请求装不进备用窗口时留在主模型上重试。 */
  readonly fits?: (context: Context) => boolean
}

/** 只重试明确的过载拒绝；断流、超时与已有输出都不能证明可以安全重发。 */
export function retryOverloadedStream(
  stream: StreamFn,
  isOverloadRejected: () => boolean,
  onRetry?: (message: AssistantMessage, nextModelId: string) => Promise<void>,
  backoffMs = 1000,
  fallback?: OverloadFallback,
): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream()
    void (async () => {
      try {
        let activeStream = stream
        let activeModel = model
        let activeOptions = options
        let switched = false
        for (let attempt = 0; attempt < 3; attempt++) {
          let start:
            | Extract<import('@earendil-works/pi-ai').AssistantMessageEvent, { type: 'start' }>
            | undefined
          let emitted = false
          let retry = false
          const current = await activeStream(activeModel, context, activeOptions)
          for await (const event of current) {
            if (event.type === 'start') {
              start = event
              continue
            }
            if (
              event.type === 'error' &&
              event.reason === 'error' &&
              !emitted &&
              event.error.content.length === 0 &&
              isOverloadRejected() &&
              !options?.signal?.aborted &&
              attempt < 2
            ) {
              // 每次尝试都有自己的派发与用量记录，SDK 自动重试仍然关闭。
              const canSwitch = !switched && fallback && (fallback.fits?.(context) ?? true)
              if (!switched && fallback && !canSwitch)
                log.warn(
                  {
                    event: 'agent.overload_fallback_skipped',
                    model: model.id,
                    fallback: fallback.model.id,
                  },
                  'overload fallback skipped because the request does not fit its context window',
                )
              if (canSwitch && fallback) {
                switched = true
                activeStream = fallback.stream
                activeModel = fallback.model
                activeOptions = { ...options, reasoning: fallback.reasoning }
                log.warn(
                  {
                    event: 'agent.overload_fallback',
                    model: model.id,
                    fallback: fallback.model.id,
                  },
                  'model overloaded before output; switching to the fallback model',
                )
              } else
                log.warn(
                  { event: 'agent.overload_retry', model: activeModel.id, attempt: attempt + 1 },
                  'model overloaded before output; retrying',
                )
              await onRetry?.(event.error, activeModel.id)
              await delay(backoffMs * (attempt + 1), options?.signal)
              retry = true
              break
            }
            if (start) {
              output.push(start)
              start = undefined
            }
            emitted = true
            output.push(event)
          }
          if (retry) continue
          output.end(await current.result())
          return
        }
      } catch (error) {
        const aborted = options?.signal?.aborted
        const message: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: aborted ? 'aborted' : 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        }
        output.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message })
        output.end(message)
      }
    })()
    return output
  }
}

async function delay(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
