import { mock } from 'bun:test'
import type { setChatFetchForTesting } from '../../lib/chatCompletion'

type ChatFetch = NonNullable<Parameters<typeof setChatFetchForTesting>[0]>

export function chatCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 依次回这些应答，用完停在最后一个 —— 重试用例靠它区分第一次和第二次。 */
export function chatFetchReturning(...bodies: Response[]): ChatFetch {
  let index = 0
  return mock(async () => {
    const body = bodies[Math.min(index, bodies.length - 1)]!
    index += 1
    return body.clone()
  }) as unknown as ChatFetch
}

export interface ChatCall {
  readonly url: string
  readonly authorization: string
  readonly model: string
  readonly images: readonly string[]
  readonly prompt: string
}

/** 记录每次请求的模型、提示词与图片，再回同一个应答。 */
export function recordingChatFetch(calls: ChatCall[], answer: () => Response): ChatFetch {
  return mock(async (url: unknown, init: unknown) => {
    const { headers, body } = init as { headers: Record<string, string>; body: string }
    const sent = JSON.parse(body) as {
      model: string
      messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[]
    }
    const parts = sent.messages[0]!.content
    calls.push({
      url: String(url),
      authorization: headers.authorization!,
      model: sent.model,
      images: parts.flatMap((part) => (part.image_url ? [part.image_url.url] : [])),
      prompt: parts.find((part) => part.type === 'text')?.text ?? '',
    })
    return answer()
  }) as unknown as ChatFetch
}
