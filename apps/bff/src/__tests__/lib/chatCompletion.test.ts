import { describe, expect, it } from 'bun:test'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { extractJson, messageContent } = await import('../../lib/chatCompletion')

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
