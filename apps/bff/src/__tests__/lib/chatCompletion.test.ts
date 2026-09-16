import { describe, expect, it } from 'bun:test'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const {
  ChatInvalidResponseError,
  ChatTimeoutError,
  ChatUpstreamError,
  chatFailure,
  extractJson,
  messageContent,
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

describe('chatFailure', () => {
  // 超时和「上游挂了」对调用方不是一回事：一个该让用户再等一次，一个该换条路。
  it('reports a deadline as 504 so the caller can say the model ran long', () => {
    expect(chatFailure(new ChatTimeoutError(90_000), 'storyboard')).toEqual({
      status: 504,
      body: { error: 'storyboard_timeout', timeout_ms: 90_000 },
    })
  })

  it('keeps an upstream status and an unusable answer on 502', () => {
    expect(chatFailure(new ChatUpstreamError(503), 'storyboard')).toEqual({
      status: 502,
      body: { error: 'storyboard_upstream_error', upstream_status: 503 },
    })
    expect(chatFailure(new ChatInvalidResponseError(), 'vision')).toEqual({
      status: 502,
      body: { error: 'vision_invalid_response' },
    })
  })

  it('leaves anything else to the route', () => {
    expect(chatFailure(new Error('boom'), 'storyboard')).toBeNull()
  })
})
