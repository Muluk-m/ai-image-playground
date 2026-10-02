import type { AgentConversationSnapshot, AgentToolResultBlock } from '@image-playground/shared'

/**
 * 跑图脚本的假 BFF：只实现跑图要走的那几条接口，不花钱、不连上游。测试与 `run.ts --mock`
 * 都用它；产出图就是这一轮的第一张参考图原样返回，对比页上一眼看得出是假数据。
 */
export interface FakeBff {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  /** 收到的每一轮请求体，测试据此断言发了什么。 */
  readonly turns: Record<string, unknown>[]
}

export interface FakeBffOptions {
  /** `no_output`：这一轮智能体没出图（只回了话）。 */
  readonly outcome?: 'image' | 'no_output'
  /** 出图时假装用的模型，缺席即请求里带的那个或 `fake-image-model`。 */
  readonly model?: string
}

interface FakeConversation {
  polls: number
  reference?: { mime: string; bytes: Uint8Array }
  model: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } {
  const [head, data] = dataUrl.split(',', 2) as [string, string]
  return {
    mime: head.slice('data:'.length, head.indexOf(';')),
    bytes: new Uint8Array(Buffer.from(data, 'base64')),
  }
}

export function createFakeBff(options: FakeBffOptions = {}): FakeBff {
  const conversations = new Map<string, FakeConversation>()
  const turns: Record<string, unknown>[] = []

  function snapshot(id: string, conversation: FakeConversation): AgentConversationSnapshot {
    conversation.polls += 1
    // 第一次轮询时那一轮还在跑，之后结束：脚本得等它，而不是看到第一张就走。
    const running = conversation.polls === 1
    const result: AgentToolResultBlock = {
      type: 'toolResult',
      toolCallId: `${id}-call`,
      toolName: 'generateImage',
      status: running ? 'submitted' : 'succeeded',
      title: 'fake',
      ...(running
        ? {}
        : {
            artifacts: [
              {
                artifactId: `${id}-artifact`,
                media: 'image',
                taskId: `task-${id}`,
                outputIndex: 0,
                mime: conversation.reference?.mime ?? 'image/png',
              },
            ],
          }),
      snapshot: {
        mode: 'image',
        args: {},
        target: { provider: 'fake', model: conversation.model },
      },
    }
    return {
      messages:
        options.outcome === 'no_output'
          ? []
          : [
              {
                id: `${id}-m`,
                turnId: `${id}-t`,
                role: 'assistant',
                content: [result],
                createdAt: 0,
              },
            ],
      turns: [],
      activeTurn: running ? { turnId: `${id}-t` } : null,
      queue: [],
    } as AgentConversationSnapshot
  }

  async function handle(input: string, init: RequestInit = {}): Promise<Response> {
    const { pathname } = new URL(input)
    const method = init.method ?? 'GET'
    if (method === 'POST' && pathname === '/api/agent/conversations') {
      const id = `c${conversations.size + 1}`
      conversations.set(id, { polls: 0, model: options.model ?? 'fake-image-model' })
      return json({ conversation: { id } })
    }
    const conversationMatch = /^\/api\/agent\/conversations\/([^/]+)\/(turns|jobs|messages)$/.exec(
      pathname,
    )
    if (conversationMatch) {
      const [, id, action] = conversationMatch as unknown as [string, string, string]
      const conversation = conversations.get(id)
      if (!conversation) return json({ error: 'not_found' }, 404)
      if (action === 'turns' && method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          references?: { dataUrl?: string }[]
          params?: { model?: string }
        }
        turns.push(body as Record<string, unknown>)
        const first = body.references?.[0]?.dataUrl
        if (first) conversation.reference = decodeDataUrl(first)
        if (!options.model && body.params?.model) conversation.model = body.params.model
        return new Response('event: done\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (action === 'jobs') return json({ jobs: [] })
      if (action === 'messages') return json(snapshot(id, conversation))
    }
    const imageMatch = /^\/v1\/queue\/requests\/task-([^/]+)\/image\/0$/.exec(pathname)
    const reference = imageMatch && conversations.get(imageMatch[1]!)?.reference
    if (reference)
      return new Response(new Uint8Array(reference.bytes).buffer as ArrayBuffer, {
        headers: { 'content-type': reference.mime },
      })
    return json({ error: 'not_found' }, 404)
  }

  return { fetch: handle, turns }
}
