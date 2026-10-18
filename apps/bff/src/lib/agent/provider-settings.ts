import { isIP } from 'node:net'
import {
  type Api,
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Model,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import {
  AGENT_PROFILE_KEYS,
  AGENT_PROVIDER_APIS,
  AGENT_PROVIDER_SECRET_REFS,
  type AgentConfiguredModel,
  type AgentModelSettings,
  type AgentProviderSettings,
  type AgentProviderTemplate,
  type AgentThinkingDepth,
  MODEL_REASONING_LEVELS,
  type ModelReasoningLevel,
} from '@image-playground/shared'
import { config } from '../../config'
import { resolveChatApiKey } from '../resolveApiKey'
import { isPublicAddress } from '../safeFetch'
import { isObject } from '../type-guards'
import { agentThinking } from './thinking'

const apis = {
  'openai-completions': openAICompletionsApi(),
  'openai-responses': openAIResponsesApi(),
  'anthropic-messages': anthropicMessagesApi(),
}
const builtins = builtinProviders().filter(
  (provider) => provider.auth.apiKey && provider.getModels().some((model) => model.api in apis),
)

function describe(model: Model<Api>): AgentConfiguredModel {
  return {
    id: model.id,
    name: model.name,
    api: model.api as AgentConfiguredModel['api'],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    imageInput: model.input.includes('image'),
    reasoningLevels: getSupportedThinkingLevels(model),
  }
}

export function agentProviderTemplates(): AgentProviderTemplate[] {
  return [
    { id: 'custom', name: '自定义 API', baseUrl: '', models: [] },
    ...builtins.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? '',
      models: provider
        .getModels()
        .filter((model) => model.api in apis)
        .map(describe),
    })),
  ]
}

export function defaultAgentModelSettings(): AgentModelSettings {
  const profiles = Object.fromEntries(
    AGENT_PROFILE_KEYS.map((key) => {
      const profile = agentThinking(
        key === 'default' ? (config.agent.model ? undefined : 'medium') : key,
      )
      return [
        key,
        { providerId: 'upstream-gateway', modelId: profile.model, reasoning: profile.effort },
      ]
    }),
  ) as AgentModelSettings['profiles']
  const models = new Map<string, AgentConfiguredModel>()
  for (const key of AGENT_PROFILE_KEYS) {
    const profile = agentThinking(
      key === 'default' ? (config.agent.model ? undefined : 'medium') : key,
    )
    models.set(profile.model, {
      id: profile.model,
      name: profile.model,
      api: 'openai-completions',
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
      imageInput: true,
      reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high'],
    })
  }
  return {
    providers: [
      {
        id: 'upstream-gateway',
        name: '现有网关',
        template: 'custom',
        baseUrl: `${config.upstream.baseUrl}/v1`,
        secretRef: '',
        models: [...models.values()],
      },
    ],
    profiles,
  }
}

export class AgentSettingsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}
function invalid(message: string): never {
  throw new AgentSettingsError(message)
}
function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max)
    invalid(`${name}不能为空或包含首尾空格`)
  return value
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('配置包含未知字段')
}
function validateModel(value: unknown): AgentConfiguredModel {
  if (!isObject(value)) invalid('模型配置无效')
  keys(value, ['id', 'name', 'api', 'contextWindow', 'maxTokens', 'imageInput', 'reasoningLevels'])
  text(value.id, '模型 ID')
  text(value.name, '模型名称')
  if (!AGENT_PROVIDER_APIS.includes(value.api as AgentConfiguredModel['api']))
    invalid('不支持的 API 协议')
  if (
    !Number.isSafeInteger(value.contextWindow) ||
    !Number.isSafeInteger(value.maxTokens) ||
    Number(value.maxTokens) <= 0 ||
    Number(value.contextWindow) <= Number(value.maxTokens)
  )
    invalid('上下文窗口必须大于输出上限，且均为正整数')
  if (typeof value.imageInput !== 'boolean') invalid('请声明模型是否支持图片输入')
  if (
    !Array.isArray(value.reasoningLevels) ||
    value.reasoningLevels.length === 0 ||
    value.reasoningLevels.some((level) => !MODEL_REASONING_LEVELS.includes(level)) ||
    new Set(value.reasoningLevels).size !== value.reasoningLevels.length
  )
    invalid('模型推理强度列表无效')
  return value as unknown as AgentConfiguredModel
}

/** The credential is always an env reference; no credential values are accepted or returned. */
export function validateAgentModelSettings(value: unknown): AgentModelSettings {
  if (!isObject(value)) invalid('模型设置无效')
  keys(value, ['providers', 'profiles'])
  if (
    !Array.isArray(value.providers) ||
    value.providers.length === 0 ||
    value.providers.length > 40
  )
    invalid('需要 1–40 个 Provider')
  const ids = new Set<string>()
  for (const provider of value.providers) {
    if (!isObject(provider)) invalid('Provider 配置无效')
    keys(provider, ['id', 'name', 'template', 'baseUrl', 'secretRef', 'models'])
    const id = text(provider.id, 'Provider ID', 80)
    if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id))
      invalid('Provider ID 必须唯一，且只使用小写字母、数字和连字符')
    ids.add(id)
    text(provider.name, 'Provider 名称')
    if (provider.template !== 'custom' && !builtins.some((item) => item.id === provider.template))
      invalid('未知 Pi Provider')
    if (typeof provider.baseUrl !== 'string') invalid('API 地址无效')
    const legacyGateway =
      id === 'upstream-gateway' &&
      provider.template === 'custom' &&
      provider.baseUrl === `${config.upstream.baseUrl}/v1`
    if (provider.baseUrl) {
      let url: URL
      try {
        url = new URL(provider.baseUrl)
      } catch {
        invalid('API 地址无效')
      }
      const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1')
      if (
        !legacyGateway &&
        (hostname === 'localhost' || (isIP(hostname) && !isPublicAddress(hostname)))
      )
        invalid('新的 Provider 必须使用公网 API 地址')
      if (
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && legacyGateway)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        invalid('API 地址必须使用 HTTPS（已有部署网关除外），且不能包含凭证、查询参数或片段')
    } else if (provider.template === 'custom') invalid('自定义 Provider 需要 API 地址')
    if (
      typeof provider.secretRef !== 'string' ||
      (!(
        AGENT_PROVIDER_SECRET_REFS.includes(
          provider.secretRef as (typeof AGENT_PROVIDER_SECRET_REFS)[number],
        ) || /^AGENT_PROVIDER_[A-Z0-9_]{1,80}_API_KEY$/.test(provider.secretRef)
      ) &&
        !(
          id === 'upstream-gateway' &&
          provider.secretRef === '' &&
          provider.template === 'custom' &&
          provider.baseUrl === `${config.upstream.baseUrl}/v1`
        ))
    )
      invalid(
        '请使用允许的 API key 环境变量或 AGENT_PROVIDER_*_API_KEY；仅原地址的现有网关可沿用凭证',
      )
    if (!Array.isArray(provider.models) || provider.models.length > 200)
      invalid('自定义模型列表无效')
    const modelIds = new Set<string>()
    for (const raw of provider.models) {
      const model = validateModel(raw)
      if (modelIds.has(model.id)) invalid('同一 Provider 下的模型 ID 不能重复')
      modelIds.add(model.id)
    }
  }
  if (!isObject(value.profiles)) invalid('需要产品档位配置')
  keys(value.profiles, [...AGENT_PROFILE_KEYS])
  const settings = value as unknown as AgentModelSettings
  for (const key of AGENT_PROFILE_KEYS) {
    const profile = value.profiles[key]
    if (!isObject(profile)) invalid(`缺少 ${key} 档位`)
    keys(profile, ['providerId', 'modelId', 'reasoning'])
    const provider = settings.providers.find((item) => item.id === profile.providerId)
    if (!provider) invalid(`${key} 档位引用了不存在的 Provider`)
    const model = configuredModels(provider).find((item) => item.id === profile.modelId)
    if (!model) invalid(`${key} 档位引用了不存在的模型`)
    if (!model.input.includes('image'))
      invalid(`${key} 档位需要支持图片输入的模型，以便使用视觉工具`)
    if (!getSupportedThinkingLevels(model).includes(profile.reasoning as ModelReasoningLevel))
      invalid(`${key} 档位的模型不支持所选推理强度`)
  }
  return settings
}

type PiThinkingMap = NonNullable<Model<Api>['thinkingLevelMap']>

function configuredThinkingMap({
  custom,
  original,
}: {
  custom: AgentConfiguredModel
  original: Model<Api> | undefined
}): PiThinkingMap {
  const mapping: PiThinkingMap = {}
  for (const level of MODEL_REASONING_LEVELS) {
    if (!custom.reasoningLevels.includes(level)) mapping[level] = null
    else if (level !== 'off') {
      const native = original?.thinkingLevelMap?.[level]
      mapping[level] = native === undefined ? level : native
    }
  }
  if (!custom.reasoningLevels.includes('off')) return mapping
  if (original) {
    // null forbids off; undefined leaves the protocol's native off behavior intact.
    if (original.thinkingLevelMap?.off !== undefined) mapping.off = original.thinkingLevelMap.off
    return mapping
  }
  switch (custom.api) {
    case 'openai-completions':
    case 'openai-responses':
      mapping.off = 'none'
      return mapping
    case 'anthropic-messages':
      return mapping
    default: {
      const _exhaustive: never = custom.api
      return _exhaustive
    }
  }
}

export function configuredModels(provider: AgentProviderSettings): Model<Api>[] {
  const template = builtins.find((item) => item.id === provider.template)
  const models = new Map(
    template
      ?.getModels()
      .filter((model) => model.api in apis)
      .map((model) => [model.id, model]),
  )
  for (const custom of provider.models) {
    const candidate = models.get(custom.id)
    const original = candidate?.api === custom.api ? candidate : undefined
    models.set(custom.id, {
      ...original,
      id: custom.id,
      name: custom.name,
      api: custom.api,
      provider: template?.id ?? provider.id,
      baseUrl: provider.baseUrl || original?.baseUrl || template?.baseUrl || '',
      contextWindow: custom.contextWindow,
      maxTokens: custom.maxTokens,
      input: custom.imageInput ? ['text', 'image'] : ['text'],
      reasoning:
        original?.reasoning === true || custom.reasoningLevels.some((level) => level !== 'off'),
      thinkingLevelMap: configuredThinkingMap({ custom, original }),
      cost: original?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(provider.id === 'upstream-gateway' && custom.api === 'openai-completions'
        ? {
            compat: {
              supportsStore: false,
              supportsReasoningEffort: true,
              maxTokensField: 'max_tokens',
              supportsUsageInStreaming: true,
              supportsStrictMode: false,
            },
          }
        : {}),
    })
  }
  return [...models.values()].map((model) => ({
    ...model,
    provider: template?.id ?? provider.id,
    baseUrl: provider.baseUrl || model.baseUrl,
  }))
}

export function providerCredentialReady(provider: AgentProviderSettings): boolean {
  return provider.secretRef
    ? !!process.env[provider.secretRef]?.trim()
    : !!resolveChatApiKey(provider.models[0]?.id ?? '')
}

/** Snapshot once before pricing; all calls in this turn use this same model and effort. */
export function configuredAgentRuntime(settings: AgentModelSettings, depth?: AgentThinkingDepth) {
  const profile = settings.profiles[depth ?? 'default']
  const provider = settings.providers.find((item) => item.id === profile.providerId)
  if (!provider) invalid('所选 Provider 不存在')
  const model = configuredModels(provider).find((item) => item.id === profile.modelId)
  if (!model) invalid('所选模型不存在')
  // The legacy gateway used a non-reasoning model for the default/off profile.
  // Preserve its system-message wire role even though the configurable model also exposes effort levels.
  if (
    provider.id === 'upstream-gateway' &&
    model.api === 'openai-completions' &&
    profile.reasoning === 'off'
  ) {
    model.compat = { ...model.compat, supportsDeveloperRole: false }
  }
  const apiKey = provider.secretRef
    ? process.env[provider.secretRef]?.trim()
    : resolveChatApiKey(model.id)
  if (!apiKey) invalid('所选 Provider 尚未配置服务端密钥')
  const template = builtins.find((item) => item.id === provider.template)
  const models = createModels()
  models.setProvider(
    createProvider({
      id: model.provider,
      name: provider.name,
      headers: template?.headers,
      models: [model],
      api: apis,
      auth: { apiKey: { name: provider.name, resolve: async () => ({ auth: { apiKey } }) } },
    }),
  )
  return {
    model,
    models,
    effort: profile.reasoning,
    providerId: provider.id,
    trustedGateway:
      provider.id === 'upstream-gateway' &&
      provider.template === 'custom' &&
      provider.baseUrl === `${config.upstream.baseUrl}/v1`,
  }
}
export type ConfiguredAgentRuntime = ReturnType<typeof configuredAgentRuntime>
