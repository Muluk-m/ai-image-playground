import { Elysia, t } from 'elysia'
import { parseAgentPromptFilters } from '../../contracts'
import { AgentPromptQueryError, getAgentPrompts } from '../lib/agent-prompts'
import { requireAuth } from '../lib/middleware'

export const agentPromptsRoutes = new Elysia().use(requireAuth).get(
  '/api/agent-prompts',
  async ({ query, status }) => {
    const filters = parseAgentPromptFilters(query)
    if (!filters) return status(400, { error: '无效的提示词筛选条件或时间范围（最多 31 天）' })
    try {
      return await getAgentPrompts(filters, query.cursor)
    } catch (error) {
      if (error instanceof AgentPromptQueryError) return status(400, { error: error.message })
      throw error
    }
  },
  {
    query: t.Object({
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      status: t.Optional(t.String()),
      edited: t.Optional(t.String()),
      userId: t.Optional(t.String()),
      deviceId: t.Optional(t.String()),
      q: t.Optional(t.String()),
      cursor: t.Optional(t.String({ maxLength: 500 })),
    }),
  },
)
