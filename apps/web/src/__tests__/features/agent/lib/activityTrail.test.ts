import { describe, expect, it } from 'vitest'
import { groupPanelMessages, isProcessStep } from '../../../../features/agent/lib/activityTrail'
import type { AgentPanelMessage } from '../../../../features/agent/types'

const tool = (over: Partial<AgentPanelMessage> & { id: string }): AgentPanelMessage =>
  ({
    kind: 'tool',
    turnId: 'turn-1',
    toolCallId: `call-${over.id}`,
    title: 'step',
    status: 'succeeded',
    ...over,
  }) as AgentPanelMessage

const reply = (id: string, turnId = 'turn-1'): AgentPanelMessage =>
  ({ kind: 'text', id, turnId, role: 'assistant', text: '结论' }) as AgentPanelMessage

describe('isProcessStep', () => {
  it('folds read-only calls that left nothing behind', () => {
    expect(isProcessStep(tool({ id: 'a', toolName: 'readCanvas' }))).toBe(true)
    expect(isProcessStep(tool({ id: 'b', toolName: 'viewImage' }))).toBe(true)
    expect(isProcessStep(tool({ id: 'c', toolName: 'loadSkill' }))).toBe(true)
  })

  it('never folds a generation that is still running', () => {
    // 跑到一半的生成同样两手空空，凭「有没有产物」判就会把一张活着的结果卡藏掉。
    expect(isProcessStep(tool({ id: 'd', toolName: 'generateImage', status: 'running' }))).toBe(
      false,
    )
    expect(isProcessStep(tool({ id: 'e', toolName: 'editImage', status: 'submitted' }))).toBe(false)
  })

  it('keeps a card for anything with an outcome to act on', () => {
    expect(isProcessStep(tool({ id: 'f', toolName: 'readCanvas', status: 'failed' }))).toBe(false)
    expect(
      isProcessStep(tool({ id: 'g', toolName: 'viewImage', errorCode: 'invalid_params' })),
    ).toBe(false)
    expect(isProcessStep(tool({ id: 'h', toolName: 'viewImage', artifacts: [{} as never] }))).toBe(
      false,
    )
  })

  it('keeps failed web reads inside the operation trail', () => {
    expect(
      isProcessStep(
        tool({
          id: 'web',
          toolName: 'webFetch',
          status: 'failed',
          errorCode: 'source_unavailable',
        }),
      ),
    ).toBe(true)
    expect(
      isProcessStep(
        tool({
          id: 'search',
          toolName: 'webSearch',
          status: 'failed',
          errorCode: 'invalid_params',
        }),
      ),
    ).toBe(true)
  })

  it('treats an unrecognised tool as something that produces output', () => {
    // 少一张卡是丢东西，多一张只是噪音；认不出就走保守那边。
    expect(isProcessStep(tool({ id: 'i', toolName: 'brandNewTool' as never }))).toBe(false)
    expect(isProcessStep(tool({ id: 'j' }))).toBe(false)
  })
})

describe('groupPanelMessages', () => {
  it('collapses consecutive steps into one trail and hides their own rows', () => {
    const messages = [
      tool({ id: 'a', toolName: 'readCanvas' }),
      tool({ id: 'b', toolName: 'viewImage' }),
      tool({ id: 'c', toolName: 'generateImage', status: 'running' }),
    ]
    const { trails, absorbed } = groupPanelMessages(messages)

    expect([...trails.keys()]).toEqual([0])
    expect(trails.get(0)?.steps.map((one) => one.id)).toEqual(['a', 'b'])
    expect([...absorbed]).toEqual([0, 1])
  })

  it('keeps the trail while the turn is still working', () => {
    const { trails } = groupPanelMessages([
      tool({ id: 'a', toolName: 'readCanvas' }),
      tool({ id: 'b', toolName: 'generateImage', status: 'running' }),
    ])
    // 后面那张卡还在跑，这一轮没完；这时候收掉过程，用户只剩一张孤零零的卡。
    expect(trails.get(0)?.spent).toBe(false)
  })

  it('spends the trail once the model starts answering', () => {
    const { trails } = groupPanelMessages([tool({ id: 'a', toolName: 'readCanvas' }), reply('r1')])
    expect(trails.get(0)?.spent).toBe(true)
  })

  it('spends the trail when the conversation moves to another turn', () => {
    const { trails } = groupPanelMessages([
      tool({ id: 'a', toolName: 'readCanvas' }),
      tool({ id: 'b', toolName: 'generateImage', status: 'running', turnId: 'turn-2' }),
    ])
    expect(trails.get(0)?.spent).toBe(true)
  })

  it('keeps a failed web read visible after the model answers', () => {
    const { trails, absorbed } = groupPanelMessages([
      tool({ id: 'a', toolName: 'webSearch' }),
      tool({ id: 'b', toolName: 'webFetch', status: 'failed', errorCode: 'source_unavailable' }),
      reply('r1'),
    ])
    expect(trails.get(0)?.steps.map((one) => one.id)).toEqual(['a', 'b'])
    expect(trails.get(0)?.spent).toBe(false)
    expect([...absorbed]).toEqual([0, 1])
  })
})

describe('recovered failures (BUG-46)', () => {
  const failedPlan = (id: string, turnId = 'turn-1') =>
    tool({ id, turnId, toolName: 'planImageBatch', status: 'failed', errorCode: 'invalid_params' })

  it('hides a parameter failure once the same tool succeeded later in the turn', () => {
    const messages = [
      failedPlan('bad'),
      tool({ id: 'good', toolName: 'planImageBatch' }),
      reply('r'),
    ]
    const grouping = groupPanelMessages(messages)
    expect(grouping.absorbed.has(0)).toBe(true)
    expect(grouping.absorbed.has(1)).toBe(false)
    expect(grouping.trails.size).toBe(0)
  })

  it('keeps the failure when nothing recovered it', () => {
    expect(groupPanelMessages([failedPlan('bad'), reply('r')]).absorbed.has(0)).toBe(false)
    // 后一轮才成功不算本轮已纠正：那一轮的失败用户是看见过的。
    const later = groupPanelMessages([
      failedPlan('bad'),
      tool({ id: 'good', turnId: 'turn-2', toolName: 'planImageBatch' }),
    ])
    expect(later.absorbed.has(0)).toBe(false)
    // 换了别的工具成功也不算。
    const other = groupPanelMessages([
      failedPlan('bad'),
      tool({ id: 'g', toolName: 'generateImage' }),
    ])
    expect(other.absorbed.has(0)).toBe(false)
  })

  it('keeps generation failures that the user may need to act on', () => {
    const messages = [
      tool({ id: 'up', toolName: 'generateImage', status: 'failed', errorCode: 'upstream_error' }),
      tool({ id: 'ok', toolName: 'generateImage' }),
    ]
    expect(groupPanelMessages(messages).absorbed.has(0)).toBe(false)
  })

  it('drops a recovered web read from the trail without splitting it', () => {
    const messages = [
      tool({ id: 'a', toolName: 'readCanvas' }),
      tool({ id: 'b', toolName: 'webFetch', status: 'failed', errorCode: 'source_unavailable' }),
      tool({ id: 'c', toolName: 'webFetch' }),
      reply('r'),
    ]
    const grouping = groupPanelMessages(messages)
    expect(grouping.trails.get(0)?.steps.map((one) => one.id)).toEqual(['a', 'c'])
    expect(grouping.trails.get(0)?.spent).toBe(true)
    expect([0, 1, 2].every((index) => grouping.absorbed.has(index))).toBe(true)
  })
})
