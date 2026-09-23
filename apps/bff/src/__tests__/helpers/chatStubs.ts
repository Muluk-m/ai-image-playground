import { mock } from 'bun:test'
import type { setChatFetchForTesting } from '../../lib/chatCompletion'

type ChatFetch = NonNullable<Parameters<typeof setChatFetchForTesting>[0]>

/**
 * 断掉会话自动命名（`lib/agent/start-turn.ts` 的 `nameConversation`）与压缩摘要用的 chat 上游。
 *
 * 测试里没有上游：不断掉它，每开一轮都要真解析一次 `UPSTREAM_BASE_URL` 的域名，失败后还按
 * 500ms、1000ms 退避重试两次。那些请求与计时器白等、把 CI 日志刷满 `agent.chat_retry`，还把
 * 每一轮的收尾窗口撑宽，放大别处的竞态。回 503 是为了保持既有行为：命名照旧失败，首句标题
 * 在事务里就落库了，断言不受影响。
 */
export async function silenceChatUpstream(): Promise<void> {
  // 动态 import：这些用例要先把 env 设好再加载读 config 的模块，静态 import 会抢在前面。
  const { setChatFetchForTesting, setChatRetryBackoffForTesting } = await import(
    '../../lib/chatCompletion'
  )
  setChatRetryBackoffForTesting(0)
  // 400 而不是 5xx：重试分类器认得出它不值得再试，于是一次就停，日志里不会多出两条 chat_retry。
  setChatFetchForTesting(async () => new Response('no chat upstream in tests', { status: 400 }))
}

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
