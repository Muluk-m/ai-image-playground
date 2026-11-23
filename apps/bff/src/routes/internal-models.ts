import {
  AGENT_PROFILE_KEYS,
  type AgentConfiguredModel,
  type AgentProfileKey,
  type ManagedModel,
  type ManagedModelsView,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import {
  getChannels,
  getChannelTopology,
  isChannelCredentialReady,
  refreshChannelsIfChanged,
} from '../lib/channels'
import {
  listModelAvailability,
  refreshInactiveModels,
  setModelActive,
} from '../lib/model-availability'
import { resolveChatApiKey } from '../lib/resolveApiKey'
import { requireInternalService } from '../lib/user-auth'

function legacyGatewaySecretRef(modelId: string): string {
  const isClaude = modelId.toLowerCase().startsWith('claude-')
  if (isClaude && config.upstream.claudeApiKey) return 'UPSTREAM_CLAUDE_API_KEY'
  if (config.upstream.openaiApiKey) return 'UPSTREAM_OPENAI_API_KEY'
  return isClaude ? 'UPSTREAM_CLAUDE_API_KEY / UPSTREAM_API_KEY' : 'UPSTREAM_API_KEY'
}

/** 生成模型取自 channel，对话模型取自 Agent 的 provider 配置与已绑定档位；同一个 id 只列一次。 */
async function managedModels(): Promise<ManagedModelsView> {
  refreshChannelsIfChanged()
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

  interface ChatCandidate {
    providerId: string
    providerName: string
    model: AgentConfiguredModel
    secretRef: string
    secretConfigured: boolean
    profiles: AgentProfileKey[]
  }
  const chatCandidates = new Map<string, ChatCandidate[]>()

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
    const isLegacyGateway = provider.id === 'upstream-gateway' && !provider.secretRef
    const providerReady = isLegacyGateway ? false : providerCredentialReady(provider)
    for (const model of providerModels.values()) {
      const profiles = routedProfilesByProviderModel.get(`${provider.id}\0${model.id}`) ?? []
      const secretConfigured = isLegacyGateway
        ? Boolean(resolveChatApiKey(model.id))
        : providerReady
      const secretRef = isLegacyGateway ? legacyGatewaySecretRef(model.id) : provider.secretRef
      const list = chatCandidates.get(model.id) ?? []
      list.push({
        providerId: provider.id,
        providerName: provider.name,
        model,
        secretRef,
        secretConfigured,
        profiles,
      })
      chatCandidates.set(model.id, list)
    }
  }

  for (const [modelId, candidates] of chatCandidates) {
    if (models.has(modelId)) continue
    const routed = candidates.filter((candidate) => candidate.profiles.length > 0)
    const mergedProfiles = Array.from(
      new Set(candidates.flatMap((candidate) => candidate.profiles)),
    )
    // 多 Provider 声明同 ID 对话模型时，只要任一实际被档位引用的 Provider 缺少凭证就按未就绪提示，
    // 且让展示的来源与 secret_ref 精确指向缺失凭证（或就绪）的那条候选，避免状态与变量名自相矛盾。
    const effectiveReady =
      routed.length > 0
        ? routed.every((candidate) => candidate.secretConfigured)
        : candidates.some((candidate) => candidate.secretConfigured)
    const representative =
      routed.length > 0
        ? effectiveReady
          ? routed[0]!
          : (routed.find((candidate) => !candidate.secretConfigured) ?? routed[0]!)
        : effectiveReady
          ? (candidates.find((candidate) => candidate.secretConfigured) ?? candidates[0]!)
          : candidates[0]!
    const sourceLabel =
      candidates.length > 1
        ? `${representative.providerName} 等 ${candidates.length} 个 Provider`
        : representative.providerName
    models.set(modelId, {
      id: modelId,
      label: representative.model.name,
      kind: 'chat',
      source_label: sourceLabel,
      source_id: representative.providerId,
      secret_ref: representative.secretRef,
      secret_configured: effectiveReady,
      capabilities: [
        ...(representative.model.imageInput ? ['vision'] : []),
        representative.model.api,
      ],
      context_window: representative.model.contextWindow,
      max_tokens: representative.model.maxTokens,
      ...(mergedProfiles.length ? { agent_profiles: mergedProfiles } : {}),
    })
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
