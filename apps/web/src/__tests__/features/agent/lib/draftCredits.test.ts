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

it('prices a Gemini draft at the requested tier and a prepared GPT draft at the basic rate', () => {
  const seen: { model: string; unitMultiplier?: number }[] = []
  const quote = (input: { model: string; quantity: number; unitMultiplier?: number }) => {
    seen.push({ model: input.model, unitMultiplier: input.unitMultiplier })
    return input.quantity * 10 * (input.unitMultiplier ?? 1)
  }
  const priced = (
    id: string,
    model: string,
    provider: string,
    params: NonNullable<AgentToolMessage['snapshot']>['params'],
  ): AgentToolMessage => ({
    ...draft(id, 1),
    snapshot: { mode: 'image', args: { n: 1 }, target: { provider, model }, params },
  })
  expect(
    agentDraftCreditEstimate(
      priced('nano', 'gemini-nano-banana-2.1', 'gemini', { gemini_image_size: '2K' }),
      quote,
    ),
  ).toBe(15)
  expect(
    agentDraftCreditEstimate(
      priced('gpt', 'gpt-image-2.5-flare', 'openai-compat', {
        size: '2048x2048',
        quality: 'high',
      }),
      quote,
    ),
  ).toBe(10)
  expect(seen).toEqual([
    { model: 'gemini-nano-banana-2.1', unitMultiplier: 1.5 },
    { model: 'gpt-image-2.5-flare', unitMultiplier: 1 },
  ])
})

it('prices a draft from its output count and omits an unpriced group total', () => {
  const quote = (input: { quantity: number }) =>
    input.quantity > 0 ? input.quantity * 10 : undefined
  expect(agentDraftCreditEstimate(draft('a', 2), quote)).toBe(20)
  expect(agentPlanCreditTotal([draft('a', 2), draft('b', 1)], quote)).toBe(30)
  expect(agentPlanCreditTotal([draft('a', 1), draft('b', 0)], () => undefined)).toBeUndefined()
})
