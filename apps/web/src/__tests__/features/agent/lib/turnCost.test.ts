import { describe, expect, it } from 'vitest'
import { turnCostWithJobs } from '../../../../features/agent/lib/turnCost'
import type { AgentToolMessage } from '../../../../features/agent/types'

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
