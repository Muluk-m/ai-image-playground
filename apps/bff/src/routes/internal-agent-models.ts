import { Elysia } from 'elysia'
import { requireInternalService } from '../lib/user-auth'

export const internalAgentModelRoutes = new Elysia({ prefix: '/internal/admin/agent-models' })
  .use(requireInternalService)
  .get('/', async () => {
    const { agentModelSettingsView } = await import('../lib/agent/model-settings-store')
    return agentModelSettingsView()
  })
  .put('/', async ({ body, request, status }) => {
    const { saveAgentModelSettings, agentModelSettingsView } = await import(
      '../lib/agent/model-settings-store'
    )
    const { preflightAgentModelSave } = await import('../lib/agent/model-preflight')
    const { AgentSettingsError } = await import('../lib/agent/provider-settings')
    try {
      await preflightAgentModelSave(body)
      await saveAgentModelSettings(body, request.headers.get('x-admin-operator') || 'admin')
      return await agentModelSettingsView()
    } catch (error) {
      if (error instanceof AgentSettingsError) return status(error.status, { error: error.message })
      throw error
    }
  })
