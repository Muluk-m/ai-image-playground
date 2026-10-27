import { describe, expect, it } from 'vitest'
import { turnCostWithJobs, turnImageReceipt } from '../../../../features/agent/lib/turnCost'
import type { AgentPanelMessage, AgentToolMessage } from '../../../../features/agent/types'

const job = (id: string, charge?: number): AgentToolMessage => ({
  kind: 'tool',
  id,
  turnId: 'turn-1',
  toolCallId: id,
  title: id,
  status: charge === undefined ? 'submitted' : 'succeeded',
  job: { taskId: id, media: 'image', ...(charge === undefined ? {} : { chargedCredits: charge }) },
})

describe('turnCostWithJobs', () => {
  it('adds a later confirmed charge without counting an already settled task twice', () => {
    const cost = { chat: 0, image: 100, video: 0, chatWaived: 20 }
    expect(turnCostWithJobs(cost, [job('first', 100)]).image).toBe(100)
    expect(turnCostWithJobs(cost, [job('first', 100), job('second', 100)]).image).toBe(200)
  })

  it('keeps the known turn cost while a background job has not settled', () => {
    const cost = { chat: 0, image: 100, video: 0, chatWaived: 20, includedTaskIds: ['first'] }
    expect(turnCostWithJobs(cost, [job('first', 100), job('second')]).image).toBe(100)
  })

  it('adds only charges absent from the settled footer even when a card is missing', () => {
    const cost = { chat: 0, image: 100, video: 0, includedTaskIds: ['first', 'missing'] }
    expect(turnCostWithJobs(cost, [job('first', 100), job('second', 50), job('third')]).image).toBe(
      150,
    )
  })
})

describe('turnImageReceipt', () => {
  const image = (id: string, status: AgentToolMessage['status']): AgentToolMessage => ({
    kind: 'tool',
    id,
    turnId: 'turn-1',
    toolCallId: id,
    toolName: 'generateImage',
    title: id,
    status,
    ...(status === 'succeeded'
      ? {
          artifacts: [
            {
              artifactId: `${id}-a`,
              media: 'image',
              taskId: id,
              outputIndex: 0,
              mime: 'image/png',
            },
          ],
        }
      : {}),
  })
  const text = (id: string): AgentPanelMessage => ({
    kind: 'text',
    id,
    turnId: 'turn-1',
    role: 'assistant',
    text: '已停止',
    streaming: false,
  })

  it('lets the result card carry the receipt when it closes the turn', () => {
    expect(turnImageReceipt([image('done', 'succeeded')], 'turn-1')).toEqual({
      cardId: 'done',
      outputCount: 1,
    })
  })

  it('moves the receipt to the end of the turn when cancelled cards or text follow the result', () => {
    const messages = [image('done', 'succeeded'), image('stopped', 'failed'), text('tail')]
    expect(turnImageReceipt(messages, 'turn-1')).toEqual({ cardId: undefined, outputCount: 1 })
  })

  it('has no image receipt when every image was cancelled', () => {
    expect(turnImageReceipt([image('stopped', 'failed'), text('tail')], 'turn-1')).toBeNull()
  })
})
