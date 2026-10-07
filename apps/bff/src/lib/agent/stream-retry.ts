import type { StreamFn } from '@earendil-works/pi-agent-core'
import { type AssistantMessage, createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { log } from '../logger'

/** 只重试明确的过载拒绝；断流、超时与已有输出都不能证明可以安全重发。 */
export function retryOverloadedStream(
  stream: StreamFn,
  onRetry?: (message: AssistantMessage) => Promise<void>,
  backoffMs = 1000,
): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream()
    void (async () => {
      let last: AssistantMessage | undefined
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          let start:
            | Extract<import('@earendil-works/pi-ai').AssistantMessageEvent, { type: 'start' }>
            | undefined
          let emitted = false
          let retry = false
          const current = await stream(model, context, options)
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
              /\b(overloaded|server_overloaded)\b/i.test(event.error.errorMessage ?? '') &&
              !options?.signal?.aborted &&
              attempt < 2
            ) {
              last = event.error
              // 每次尝试都有自己的派发与用量记录，SDK 自动重试仍然关闭。
              await onRetry?.(event.error)
              log.warn(
                { event: 'agent.overload_retry', model: model.id, attempt: attempt + 1 },
                'model overloaded before output; retrying',
              )
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
          ...(last ?? {
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
          }),
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
