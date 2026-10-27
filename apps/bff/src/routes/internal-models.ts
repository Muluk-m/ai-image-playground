import type { ManagedModel, ManagedModelsView } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { getChannels } from '../lib/channels'
import {
  listModelAvailability,
  refreshInactiveModels,
  setModelActive,
} from '../lib/model-availability'
import { requireInternalService } from '../lib/user-auth'

/** 生成模型取自 channel，对话模型取自 Agent 的 provider 配置；同一个 id 只列一次。 */
async function managedModels(): Promise<ManagedModelsView> {
  const { readAgentModelSettings } = await import('../lib/agent/model-settings-store')
  const [availability, inactive, agent] = await Promise.all([
    listModelAvailability(),
    refreshInactiveModels(),
    readAgentModelSettings(),
  ])
  const models = new Map<string, Omit<ManagedModel, 'active' | 'pause_reason' | 'paused_at'>>()
  for (const channel of getChannels()) {
    for (const model of channel.models) {
      if (models.has(model.id)) continue
      models.set(model.id, {
        id: model.id,
        label: model.label,
        kind: model.media === 'video' ? 'video' : 'image',
      })
    }
  }
  for (const provider of agent.settings.providers) {
    for (const model of provider.models) {
      if (models.has(model.id)) continue
      models.set(model.id, { id: model.id, label: model.name, kind: 'chat' })
    }
  }
  return {
    models: Array.from(models.values(), (model) => {
      const row = availability.get(model.id)
      return {
        ...model,
        // 旧版收费模块停用的模型还没迁过来时只在 inactive 里，按手动下架显示。
        active: row ? row.active : !inactive.has(model.id),
        pause_reason: row?.pause_reason ?? null,
        paused_at: row?.paused_at ?? null,
      }
    }),
  }
}

export const internalModelRoutes = new Elysia({ prefix: '/internal/admin/models' })
  .use(requireInternalService)
  .get('/', () => managedModels())
  .put(
    '/:model',
    async ({ params, body, request }) => {
      await setModelActive({
        model: params.model,
        active: body.active,
        operatorId: request.headers.get('x-admin-operator') || 'admin',
      })
      return managedModels()
    },
    { body: t.Object({ active: t.Boolean() }) },
  )
