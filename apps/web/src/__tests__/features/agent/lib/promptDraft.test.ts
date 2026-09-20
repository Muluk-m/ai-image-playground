import { describe, expect, it } from 'vitest'
import { agentDraftOutputCount } from '../../../../features/agent/lib/promptDraft'
import type { AgentToolMessage } from '../../../../features/agent/types'

/**
 * 确认之后按这个数在画布上占位，服务端按 `agentImageCount` 填 `n`。两处算出的数不一样，
 * 就会出现「占了 1 个位却落下 3 张」或者「多出来的位永远转圈」。
 */
function card(n: unknown, toolName = 'editImage'): AgentToolMessage {
  return {
    kind: 'tool',
    id: 'tool-1',
    toolName,
    title: 't',
    status: 'awaiting_confirmation',
    snapshot: { args: { n } },
  } as unknown as AgentToolMessage
}

describe('agentDraftOutputCount', () => {
  it('把模型写成字符串的张数按数字读，不当成一张', () => {
    expect(agentDraftOutputCount(card('3'))).toBe(3)
  })

  it('小数截断，与服务端的整数校验落在同一个数上', () => {
    expect(agentDraftOutputCount(card(2.7))).toBe(2)
    expect(agentDraftOutputCount(card('2.7'))).toBe(2)
  })

  it('读不出数字、超出范围与视频都收口到合法张数', () => {
    expect(agentDraftOutputCount(card('很多'))).toBe(1)
    expect(agentDraftOutputCount(card(undefined))).toBe(1)
    expect(agentDraftOutputCount(card(0))).toBe(1)
    expect(agentDraftOutputCount(card(99))).toBe(10)
    expect(agentDraftOutputCount(card(3, 'generateVideo'))).toBe(1)
  })
})
