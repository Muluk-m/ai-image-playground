import { describe, expect, it } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { estimateTokens } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from '@earendil-works/pi-ai'
import { estimateMessageTokens } from '../../../lib/agent/token-estimate'

/**
 * 纯模块：不设任何 env、不连库。校正只有一条规则——在 pi 的结果之上，每个 CJK 字符补
 * `0.8 − 0.25 = 0.55` 个 token。所以这里同时钉两件事：非 CJK 的口径逐字沿用 pi，
 * 数 CJK 的文本范围与 pi 数字符的范围一致（少数一块就等于那一块又被低估回去）。
 */

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function user(content: string | (TextContent | ImageContent)[]): AgentMessage {
  return { role: 'user', content, timestamp: 1 }
}

function assistant(content: (TextContent | ThinkingContent | ToolCall)[]): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'm',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: 1,
  }
}

function toolResult(content: (TextContent | ImageContent)[]): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'generateImage',
    content,
    isError: false,
    timestamp: 1,
  }
}

const IMAGE: ImageContent = { type: 'image', data: '', mimeType: 'image/png' }

/** 只补 CJK 那一项，所以差额本身就是被校正的字符数 × 0.55 向上取整。 */
const correction = (message: AgentMessage) =>
  estimateMessageTokens(message) - estimateTokens(message)

describe('estimateMessageTokens', () => {
  it('leaves a pure ASCII message exactly where pi put it', () => {
    const message = user('Draw a ginger cat sitting on a wooden table, soft morning light.')
    expect(estimateMessageTokens(message)).toBe(estimateTokens(message))
    expect(correction(message)).toBe(0)
  })

  it('charges about one token per Chinese character', () => {
    // 100 个汉字：pi 给 ceil(100/4) = 25，校正补 ceil(100 × 0.55) = 55，合计 100 × 0.8。
    const message = user([{ type: 'text', text: '海边的日落'.repeat(20) }])
    expect(estimateTokens(message)).toBe(25)
    expect(estimateMessageTokens(message)).toBe(80)
  })

  it('corrects only the CJK half of a mixed line', () => {
    // 'Draw ' 5 个 ASCII + 4 个汉字 = 9 字符：pi 给 ceil(9/4) = 3，校正补 ceil(4 × 0.55) = 3。
    const message = user([{ type: 'text', text: 'Draw 一只橘猫' }])
    expect(estimateTokens(message)).toBe(3)
    expect(estimateMessageTokens(message)).toBe(6)
  })

  it('counts full-width punctuation and CJK brackets as CJK', () => {
    // 「，。」这些在主流词表里同样各占一个 token，漏掉它们中文句子就会被少算一成。
    const message = user([{ type: 'text', text: '「你好，世界。」' }])
    expect(estimateTokens(message)).toBe(2)
    expect(estimateMessageTokens(message)).toBe(7)
  })

  it('counts kana and hangul as CJK too', () => {
    expect(correction(user([{ type: 'text', text: 'こんにちは' }]))).toBe(3)
    expect(correction(user([{ type: 'text', text: '안녕하세요' }]))).toBe(3)
  })

  it('keeps pi fixed per-block value for images and never corrects them', () => {
    const message = user([IMAGE])
    // pi 按每块 4800 字符折算图片，没有文字可校正。
    expect(estimateTokens(message)).toBe(1_200)
    expect(estimateMessageTokens(message)).toBe(1_200)
  })

  it('corrects the text that travels with an image block', () => {
    const message = user([{ type: 'text', text: '海边的日落'.repeat(20) }, IMAGE])
    expect(estimateTokens(message)).toBe(1_225)
    expect(estimateMessageTokens(message)).toBe(1_280)
  })

  it('counts assistant text, thinking and tool call arguments, like pi does', () => {
    const text = assistant([{ type: 'text', text: '好的，这就去生成' }])
    expect(correction(text)).toBe(5)

    const thinking = assistant([{ type: 'thinking', thinking: '用户要的是海边的日落' }])
    expect(correction(thinking)).toBe(6)

    // pi 数的是 `name.length + JSON.stringify(arguments).length`，这里只有参数里的 5 个汉字是 CJK。
    const call = assistant([
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'generateImage',
        arguments: { prompt: '海边的日落' },
      },
    ])
    expect(correction(call)).toBe(3)
  })

  it('counts tool result text', () => {
    const message = toolResult([{ type: 'text', text: '生成图片：完成，图片 art-1' }])
    // '生成图片：完成，图片' 10 个 CJK 字符；ASCII 的 ' art-1' 不补。
    expect(correction(message)).toBe(6)
  })

  it('gives an empty message nothing to correct', () => {
    expect(estimateMessageTokens(user([]))).toBe(0)
    expect(estimateMessageTokens(user(''))).toBe(0)
    expect(estimateMessageTokens(user([{ type: 'text', text: '' }]))).toBe(0)
    expect(estimateMessageTokens(assistant([]))).toBe(0)
  })
})
