import {
  AGENT_PROFILE_KEYS,
  type AgentConfiguredModel,
  type AgentProfileKey,
  type ManagedModel,
  type ManagedModelsView,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { getChannels, getChannelTopology, isChannelCredentialReady } from '../lib/channels'
import {
  listModelAvailability,
  refreshInactiveModels,
  setModelActive,
} from '../lib/model-availability'
import { requireInternalService } from '../lib/user-auth'

/** 生成模型取自 channel，对话模型取自 Agent 的 provider 配置与已绑定档位；同一个 id 只列一次。 */
async function managedModels(): Promise<ManagedModelsView> {
  const { readAgentModelSettings } = await import('../lib/agent/model-settings-store')
  const { agentProviderTemplates, providerCredentialReady } = await import(
    '../lib/agent/provider-settings'
  )
  const [availability, inactive, agent] = await Promise.all([
    listModelAvailability(),
    refreshInactiveModels(),
    readAgentModelSettings(),
  ])
  const templates = agentProviderTemplates()
  const templatesById = new Map(templates.map((template) => [template.id, template]))

  const routedProfilesByProviderModel = new Map<string, AgentProfileKey[]>()
  const addRoutedProfile = (
    providerId: string | undefined,
    modelId: string | undefined,
    profileKey: AgentProfileKey,
  ) => {
    if (!providerId || !modelId) return
    const slot = `${providerId}\0${modelId}`
    const existing = routedProfilesByProviderModel.get(slot) ?? []
    if (!existing.includes(profileKey)) {
      existing.push(profileKey)
      routedProfilesByProviderModel.set(slot, existing)
    }
  }
  for (const key of AGENT_PROFILE_KEYS) {
    const profile = agent.settings.profiles[key]
    addRoutedProfile(profile.providerId, profile.modelId, key)
    addRoutedProfile(profile.fallback?.providerId, profile.fallback?.modelId, key)
  }

  const models = new Map<string, Omit<ManagedModel, 'active' | 'pause_reason' | 'paused_at'>>()
  for (const channel of getChannels()) {
    const secretConfigured = isChannelCredentialReady(channel)
    for (const model of channel.models) {
      if (models.has(model.id)) continue
      const maxConcurrency = channel.modelMaxConcurrency?.[model.id] ?? channel.maxConcurrency
      models.set(model.id, {
        id: model.id,
        label: model.label,
        kind: model.media === 'video' ? 'video' : 'image',
        source_label: channel.label,
        source_id: channel.id,
        secret_ref: channel.auth.secretRef,
        secret_configured: secretConfigured,
        capabilities: model.capabilities,
        ...(maxConcurrency !== undefined ? { max_concurrency: maxConcurrency } : {}),
        ...(model.etaSeconds !== undefined ? { eta_seconds: model.etaSeconds } : {}),
      })
    }
  }

  for (const provider of agent.settings.providers) {
    const templateModels = new Map(
      (templatesById.get(provider.template)?.models ?? []).map((model) => [model.id, model]),
    )
    const providerModels = new Map<string, AgentConfiguredModel>()
    for (const model of provider.models) {
      providerModels.set(model.id, model)
    }
    // 档位直接引用内置 Pi 目录模型时，一并纳入后台模型目录以便查看状态与配置积分定价。
    for (const key of AGENT_PROFILE_KEYS) {
      const profile = agent.settings.profiles[key]
      for (const binding of [profile, profile.fallback]) {
        if (!binding || binding.providerId !== provider.id) continue
        if (providerModels.has(binding.modelId)) continue
        const fromTemplate = templateModels.get(binding.modelId)
        if (fromTemplate) providerModels.set(fromTemplate.id, fromTemplate)
      }
    }
    const secretConfigured = providerCredentialReady(provider)
    const secretRef =
      provider.secretRef || (provider.id === 'upstream-gateway' ? 'UPSTREAM_API_KEY' : '')
    for (const model of providerModels.values()) {
      const profiles = routedProfilesByProviderModel.get(`${provider.id}\0${model.id}`)
      const existing = models.get(model.id)
      if (existing) {
        if (existing.kind !== 'chat') continue
        // 多 Provider 声明同一模型 ID 时，优先保留当前被产品思考档位实际引用的 Provider 条目。
        if (existing.agent_profiles?.length || !profiles?.length) continue
      }
      models.set(model.id, {
        id: model.id,
        label: model.name,
        kind: 'chat',
        source_label: provider.name,
        source_id: provider.id,
        secret_ref: secretRef,
        secret_configured: secretConfigured,
        capabilities: [...(model.imageInput ? ['vision'] : []), model.api],
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
        ...(profiles?.length ? { agent_profiles: profiles } : {}),
      })
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
    channels: getChannelTopology(),
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
        operatorId: request.headers.get('x-admin-operator') || body.operatorId || 'admin',
        reason: body.reason,
      })
      return managedModels()
    },
    {
      body: t.Object({
        active: t.Boolean(),
        reason: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
        operatorId: t.Optional(t.String({ minLength: 1, maxLength: 320 })),
      }),
    },
  )
