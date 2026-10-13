import { createParser } from 'eventsource-parser'

const OVERLOAD = /\b(?:overloaded|overloaded_error|server_overloaded|overload_error)\b/i

/** 只采集上游明确返回的拒绝；底层断流抛出的同名错误不是拒绝证据。 */
export function observeOverloadResponse(response: Response) {
  let explicitOverload = false
  const isRejected = (message: string) =>
    response.status === 503 ||
    response.status === 529 ||
    ((response.ok || response.status === 429 || response.status >= 500) &&
      (explicitOverload || (!response.ok && OVERLOAD.test(message))))
  if (!response.body) return { response, isRejected }

  const inspect = (data: string) => {
    try {
      const error: unknown = JSON.parse(data)?.error
      if (!error || typeof error !== 'object') return
      explicitOverload ||= [
        'type' in error ? error.type : undefined,
        'code' in error ? error.code : undefined,
        'message' in error ? error.message : undefined,
      ].some((value) => typeof value === 'string' && OVERLOAD.test(value))
    } catch {
      // 非 JSON 帧由 SDK 处理，旁路观察不改变响应。
    }
  }
  const decoder = new TextDecoder()
  let observing = true
  let json = ''
  const sse = response.headers.get('content-type')?.includes('text/event-stream')
  const parser = createParser({
    maxBufferSize: 64 * 1024,
    onEvent: ({ data }) => inspect(data),
    onError: () => {
      observing = false
    },
  })
  const feed = (text: string) => {
    if (!observing) return
    if (sse) parser.feed(text)
    else if (json.length + text.length <= 64 * 1024) json += text
    else {
      observing = false
      json = ''
    }
    if (!observing) parser.reset()
  }
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        feed(decoder.decode(chunk, { stream: true }))
        controller.enqueue(chunk)
      },
      flush() {
        feed(decoder.decode())
        if (observing && !sse) inspect(json)
      },
    }),
  )
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    isRejected,
  }
}
