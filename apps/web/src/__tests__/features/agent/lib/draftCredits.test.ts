import { expect, it } from 'vitest'
import {
  agentDraftCreditEstimate,
  agentPlanCreditTotal,
} from '../../../../features/agent/lib/draftCredits'
import type { AgentToolMessage } from '../../../../features/agent/types'

function draft(id: string, n: number): AgentToolMessage {
  return {
    kind: 'tool',
    id,
    turnId: 'turn',
    toolCallId: id,
    toolName: 'generateImage',
    title: id,
    status: 'awaiting_confirmation',
    snapshot: {
      mode: 'image',
      args: { n },
      target: { provider: 'openai-compat', model: 'fixture' },
    },
  }
}

it('prices a draft from its output count and omits an unpriced group total', () => {
  const quote = (input: { quantity: number }) =>
    input.quantity > 0 ? input.quantity * 10 : undefined
  expect(agentDraftCreditEstimate(draft('a', 2), quote)).toBe(20)
  expect(agentPlanCreditTotal([draft('a', 2), draft('b', 1)], quote)).toBe(30)
  expect(agentPlanCreditTotal([draft('a', 1), draft('b', 0)], () => undefined)).toBeUndefined()
})
