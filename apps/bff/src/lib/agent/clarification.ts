import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AgentClarificationBlock } from '@image-playground/shared'
import { Type } from 'typebox'

export const AGENT_CLARIFICATION_TOOL = 'askClarification'

const MIN_OPTIONS = 2
const MAX_OPTIONS = 4
const COUNT = `${MIN_OPTIONS}-${MAX_OPTIONS}`

interface ClarificationDetails {
  readonly clarification: AgentClarificationBlock
}

const parameters = Type.Object({
  question: Type.String({ description: '一句话问清你拿不准的那一点，不要铺陈。' }),
  options: Type.Array(Type.String(), {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: `${COUNT} 个互斥的选项，每项一句短语；用户点其中一项就是他的下一条消息。`,
  }),
})

/** 数量由 schema 挡在 `execute` 之前，这里只管修剪后还剩几个。 */
function clarify(question: string, options: string[]): AgentToolResult<ClarificationDetails> {
  const asked = question.trim()
  const picks = options.map((option) => option.trim()).filter(Boolean)
  if (!asked) throw new Error('澄清要带一句问题')
  if (picks.length < MIN_OPTIONS) throw new Error(`选项要 ${COUNT} 个，请重问一次`)
  return {
    content: [{ type: 'text', text: '单选已经发给用户，等他选。' }],
    details: { clarification: { type: 'clarification', question: asked, options: picks } },
  }
}

const tool: AgentTool<typeof parameters, ClarificationDetails> = {
  name: AGENT_CLARIFICATION_TOOL,
  label: '澄清',
  description:
    '拿不准用户要哪一种时，给他一个单选。发出后这一轮就结束，他选的那一项会作为下一条用户消息回来。',
  parameters,
  execute: async (_toolCallId, params) => clarify(params.question, params.options),
}

export const clarificationTool = tool as AgentTool

export function clarificationFromResult(result: unknown): AgentClarificationBlock | null {
  return (result as { details?: ClarificationDetails } | undefined)?.details?.clarification ?? null
}
