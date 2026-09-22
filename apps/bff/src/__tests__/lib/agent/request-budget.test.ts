import { describe, expect, it } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Context, ImageContent } from '@earendil-works/pi-ai'
import { type CompactionSettings, compactionBudget } from '../../../lib/agent/compaction'
import {
  AgentContextOverflow,
  assertRequestWithinBudget,
  requestInputTokens,
  requestOverheadTokens,
} from '../../../lib/agent/request-budget'
import { estimateMessageTokens } from '../../../lib/agent/token-estimate'

/**
 * 预算口径的临界值：高层的路由测试断言「真发出去的那一份在预算内」，这里只钉住算式本身，
 * 因为越界那一格从高层很难稳定命中。
 */

const SETTINGS: CompactionSettings = {
  contextWindow: 10_000,
  maxOutputTokens: 4_000,
  outputReserveTokens: 1_000,
  bufferTokens: 500,
  keepRecentTokens: 200,
  verbatimTokens: 100,
  failureThreshold: 3,
  breakerCooldownMs: 60_000,
}

function text(role: 'user' | 'assistant', value: string): AgentMessage {
  return { role, content: [{ type: 'text', text: value }], timestamp: 0 } as AgentMessage
}

/** 只要 IHDR 那几个字节：折算读的是文件头，不解码整张图（见 `token-estimate.ts`）。 */
function png(width: number, height: number): ImageContent {
  const bytes = Buffer.alloc(24)
  bytes.write('\x89PNG\r\n\x1a\n', 0, 'binary')
  bytes.write('IHDR', 12, 'binary')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }
}

/** 一段来回看图的历史：每条一句话加一张图，真正占地方的是图片块。 */
function gallery(image: ImageContent, count: number): Context {
  return {
    systemPrompt: '短',
    messages: Array.from(
      { length: count },
      () =>
        ({
          role: 'user',
          content: [{ type: 'text', text: '再亮一点' }, image],
          timestamp: 0,
        }) as AgentMessage,
    ),
  } as unknown as Context
}

const TOOL = {
  name: 'generateImage',
  description: '按提示词发起一次生图',
  parameters: { type: 'object', properties: { prompt: { type: 'string' } } },
}

// 上限与压缩阈值同源，不另起一个数：这两条盯的就是这条相等关系。
it('上限是窗口扣掉输出预留与计数误差余量', () => {
  expect(compactionBudget(SETTINGS).threshold).toBe(10_000 - 1_000 - 500)
})

it('输出预留不超过模型真能出的那么多', () => {
  expect(compactionBudget({ ...SETTINGS, maxOutputTokens: 200 }).threshold).toBe(10_000 - 200 - 500)
})

describe('固定开销', () => {
  // 系统说明与工具清单不是消息，却每次请求都发出去。压缩只数消息，所以它们从前一个 token
  // 都没进过闸门——这正是这一票要补的口子。
  it('把系统说明与工具清单按与消息同一条口径折算', () => {
    const systemPrompt = '你是创作模式画布旁的助手'
    const expected =
      estimateMessageTokens(text('user', systemPrompt)) +
      estimateMessageTokens(text('user', JSON.stringify([TOOL])))

    expect(requestOverheadTokens({ systemPrompt, tools: [TOOL] })).toBe(expected)
  })

  it('两样都没有时是零', () => {
    expect(requestOverheadTokens({})).toBe(0)
  })
})

describe('整份请求的输入', () => {
  it('固定开销与消息一起算，不漏掉任何一段', () => {
    const context: Context = {
      systemPrompt: '你是助手',
      tools: [TOOL],
      messages: [text('user', '画一只猫'), text('assistant', '好的')],
    } as unknown as Context

    expect(requestInputTokens(context)).toBe(
      requestOverheadTokens(context) +
        estimateMessageTokens(text('user', '画一只猫')) +
        estimateMessageTokens(text('assistant', '好的')),
    )
  })
})

describe('出站硬闸', () => {
  const within: Context = {
    systemPrompt: '短',
    messages: [text('user', '画一只猫')],
  } as unknown as Context

  it('预算内放行', () => {
    expect(() => assertRequestWithinBudget(within, SETTINGS)).not.toThrow()
  })

  // 摘要失败时历史正是最长的那一份：回退成「发完整历史」必然更超。拒发才是安全的停止。
  it('超限就拒发，并说出超了多少', () => {
    const huge: Context = {
      systemPrompt: '短',
      messages: [text('user', 'x'.repeat(200_000))],
    } as unknown as Context

    let thrown: unknown
    try {
      assertRequestWithinBudget(huge, SETTINGS)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentContextOverflow)
    const overflow = thrown as AgentContextOverflow
    expect(overflow.limit).toBe(compactionBudget(SETTINGS).threshold)
    expect(overflow.inputTokens).toBeGreaterThan(overflow.limit)
  })

  // 只有工具清单与系统说明就已经装不下：消息再怎么裁也没用，同样拒发。
  it('固定开销自己就超限时照样拒发', () => {
    const overhead: Context = {
      systemPrompt: 'x'.repeat(200_000),
      messages: [text('user', '嗯')],
    } as unknown as Context

    expect(() => assertRequestWithinBudget(overhead, SETTINGS)).toThrow(AgentContextOverflow)
  })

  // 图片块也要过闸，而且是按像素过：同样八张图，按预览发装得下、按原件发装不下——
  // `viewImage` 省下来的正是这个差额（#396）。换成 pi 的每块固定值，两者一样大，
  // 这道闸就再也分不出预览和原件。
  it('图片按像素进闸：同样八张，预览放行、原件拒发', () => {
    expect(() => assertRequestWithinBudget(gallery(png(1024, 614), 8), SETTINGS)).not.toThrow()

    let thrown: unknown
    try {
      assertRequestWithinBudget(gallery(png(2000, 1200), 8), SETTINGS)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentContextOverflow)
    expect((thrown as AgentContextOverflow).inputTokens).toBeGreaterThan(
      compactionBudget(SETTINGS).threshold,
    )
  })
})
