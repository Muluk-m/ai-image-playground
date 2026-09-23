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
})
