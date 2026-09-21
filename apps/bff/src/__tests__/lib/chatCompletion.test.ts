import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isObject } from '../../lib/type-guards'
import { chatCompletion } from '../helpers/chatStubs'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''
process.env.LOG_LEVEL = 'silent'

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const {
  ChatInvalidResponseError,
  ChatTimeoutError,
  ChatUpstreamError,
  askChatModel,
  extractJson,
  messageContent,
  setChatFetchForTesting,
  setChatRetryBackoffForTesting,
} = await import('../../lib/chatCompletion')

describe('extractJson', () => {
  it('reads the object out of a fenced block, out of prose, and out of bare JSON', () => {
    const plan = { title: '通勤第一口', shots: [] }

    expect(extractJson(`好的：\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\n以上。`)).toEqual(plan)
    expect(extractJson(`这是结果 ${JSON.stringify(plan)} 请查收`)).toEqual(plan)
    expect(extractJson(JSON.stringify(plan))).toEqual(plan)
  })

  it('gives up on an answer carrying no object', () => {
    expect(extractJson('没有 JSON')).toBeUndefined()
    expect(extractJson('{ not json }')).toBeUndefined()
  })
})

describe('messageContent', () => {
  it('takes the first choice message text', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: '答案' } }] })

    expect(messageContent(raw)).toBe('答案')
  })

  it('gives up on a payload shaped like anything else', () => {
    expect(messageContent('not json')).toBeUndefined()
    expect(messageContent(JSON.stringify({ choices: [] }))).toBeUndefined()
    expect(messageContent(JSON.stringify({ choices: [{ message: {} }] }))).toBeUndefined()
  })
})

const ASK = {
  model: 'fixture-summary-model',
  prompt: '回一个 JSON',
  maxTokens: 64,
  timeoutMs: 1_000,
}

function parseAnswer(value: unknown): { answer: string } | null {
  if (!isObject(value) || typeof value.answer !== 'string') return null
  return { answer: value.answer }
}

let sent = 0

/** 按脚本逐次应答；脚本用完还来请求就当场失败——发了几次是这些用例的核心断言。 */
function scriptedChat(...answers: (() => Response)[]): void {
  sent = 0
  setChatFetchForTesting(async () => {
    const answer = answers[sent]
    sent += 1
    if (!answer) throw new Error(`unexpected chat request no ${sent}`)
    return answer()
  })
}

describe('askChatModel', () => {
  beforeEach(() => {
    // 真退避一轮要 1.5 秒，而这些用例只数请求次数，不关心墙钟。
    setChatRetryBackoffForTesting(0)
  })

  afterEach(() => {
    setChatFetchForTesting()
    setChatRetryBackoffForTesting()
  })

  it('retries a transient upstream failure and answers from the second try', async () => {
    scriptedChat(
      () => new Response('bad gateway', { status: 502 }),
      () => chatCompletion('{"answer":"好"}'),
    )

    expect(await askChatModel(ASK, parseAnswer)).toEqual({ answer: '好' })
    expect(sent).toBe(2)
  })

  it('tells quota exhaustion apart from throttling, both arriving as 429', async () => {
    scriptedChat(
      () =>
        new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 }),
    )

    await expect(askChatModel(ASK, parseAnswer)).rejects.toBeInstanceOf(ChatUpstreamError)
    expect(sent).toBe(1)

    scriptedChat(
      () => new Response('rate limit exceeded, slow down', { status: 429 }),
      () => chatCompletion('{"answer":"好"}'),
    )

    expect(await askChatModel(ASK, parseAnswer)).toEqual({ answer: '好' })
    expect(sent).toBe(2)
  })

  it('does not retry its own deadline even when the transport error reads as transient', async () => {
    sent = 0
    setChatFetchForTesting(async (_input, init) => {
      sent += 1
      const { promise, reject } = Promise.withResolvers<never>()
      // 等 deadline 真的切下来再断，不猜时长；断的措辞正是分类器眼里「该重试」的那种。
      init?.signal?.addEventListener('abort', () => reject(new Error('socket hang up')))
      return promise
    })

    await expect(askChatModel({ ...ASK, timeoutMs: 5 }, parseAnswer)).rejects.toBeInstanceOf(
      ChatTimeoutError,
    )
    expect(sent).toBe(1)
  })

  it('surfaces the last upstream error once the retry budget runs out', async () => {
    scriptedChat(
      () => new Response('bad gateway', { status: 502 }),
      () => new Response('bad gateway', { status: 502 }),
      () => new Response('service unavailable', { status: 503 }),
    )

    await expect(askChatModel(ASK, parseAnswer)).rejects.toMatchObject({
      name: 'ChatUpstreamError',
      status: 503,
    })
    expect(sent).toBe(3)
  })

  it('asks once more when the answer is unusable, then reports an invalid response', async () => {
    scriptedChat(
      () => chatCompletion('抱歉，我不会'),
      () => chatCompletion('还是不会'),
    )

    await expect(askChatModel(ASK, parseAnswer)).rejects.toBeInstanceOf(ChatInvalidResponseError)
    expect(sent).toBe(2)
  })

  it('counts both retry reasons against a single request budget', async () => {
    scriptedChat(
      () => chatCompletion('抱歉，我不会'),
      () => new Response('bad gateway', { status: 502 }),
      () => new Response('bad gateway', { status: 502 }),
    )

    await expect(askChatModel(ASK, parseAnswer)).rejects.toBeInstanceOf(ChatUpstreamError)
    expect(sent).toBe(3)
  })
})
