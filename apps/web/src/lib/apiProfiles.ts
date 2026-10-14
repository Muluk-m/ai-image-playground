import { i18next } from '../i18n'
import type { ApiMode, AppSettings } from '../types'
import { channelsSettled } from './channels/channelStore'
import { getPublicChannel, getPublicChannels } from './channels/publicChannels'
import type { BuiltinEdgeProfile, ClientProfile, PublicChannel } from './channels/types'

export const DEFAULT_API_TIMEOUT = 600

/**
 * 渠道还没装载时的占位。不写入 settings.profiles，也不带密钥。
 * 提交路径看到空 channelId 会停下来，而不是发出去。
 */
export const EMPTY_PLATFORM_PROFILE: BuiltinEdgeProfile = {
  id: '',
  source: 'builtin-edge',
  channelId: '',
  selectedModelId: '',
}

/**
 * 超时必须是正数：`setTimeout(() => controller.abort(), 0)` 会在请求发出的同一个 tick
 * 把它掐断，浏览器只丢下一句 `The user aborted a request.`，看着像用户点了取消。
 * 渠道下发的 defaults 走这里退回默认值。
 */
export function normalizeApiTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_API_TIMEOUT
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function builtinEdgeProfileId(channelId: string): string {
  return channelId
}

export function createBuiltinEdgeProfile(
  channelId: string,
  selectedModelId: string,
): BuiltinEdgeProfile {
  return { id: builtinEdgeProfileId(channelId), source: 'builtin-edge', channelId, selectedModelId }
}

/** 只认平台渠道。旧的 user-byok / 自定义端点记录返回 null，调用方丢掉。 */
export function normalizeClientProfile(input: unknown): ClientProfile | null {
  if (!isRecord(input) || input.source !== 'builtin-edge') return null
  if (typeof input.channelId !== 'string' || !input.channelId.trim()) return null
  if (typeof input.selectedModelId !== 'string' || !input.selectedModelId.trim()) return null
  return {
    id:
      typeof input.id === 'string' && input.id.trim()
        ? input.id
        : builtinEdgeProfileId(input.channelId),
    source: 'builtin-edge',
    channelId: input.channelId,
    selectedModelId: input.selectedModelId,
  }
}

function injectBuiltinEdgeProfiles(stored: ClientProfile[]): ClientProfile[] {
  const channels = getPublicChannels()
  // 清单还在路上时，留下已经存好的平台档案。空数组这时不是「没有渠道」，
  // 不能把用户选的模型清掉；清单到达后再校验、再回退。
  if (!channelsSettled()) return stored
  const existingByChannelId = new Map(stored.map((profile) => [profile.channelId, profile]))

  const builtinProfiles: BuiltinEdgeProfile[] = []
  for (const channel of channels) {
    if (!channel.models.length) continue
    const existing = existingByChannelId.get(channel.id)
    if (existing && channel.models.some((model) => model.id === existing.selectedModelId)) {
      builtinProfiles.push(existing)
    } else {
      builtinProfiles.push(createBuiltinEdgeProfile(channel.id, channel.models[0].id))
    }
  }
  return builtinProfiles
}

// 已经经过 normalizeSettings 的对象短路返回自身，避免 store / UI / dispatch 路径上的重复正规化。
// 缓存跟着 channel 列表走：store hydrate 早于 channel 装载，那一轮的结果既没有内置 profile
// 也修不掉失效的 selectedModelId，列表换了就必须重算而不是命中缓存。
let normalizedSettingsCache = new WeakSet<AppSettings>()
let cachedAgainstChannels: PublicChannel[] | null = null

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 正规化设置。旧 localStorage / 导入包里的 user-byok profile 与 customProviders 直接丢掉，
 * 活动配置若指着被丢掉的档案，落到当前渠道列表的第一个平台渠道。
 */
export function normalizeSettings(input: Partial<AppSettings> | unknown): AppSettings {
  const channels = getPublicChannels()
  if (channels !== cachedAgainstChannels) {
    normalizedSettingsCache = new WeakSet<AppSettings>()
    cachedAgainstChannels = channels
  }
  if (input && typeof input === 'object' && normalizedSettingsCache.has(input as AppSettings)) {
    return input as AppSettings
  }
  const record = isRecord(input) ? input : {}

  const rawProfiles = Array.isArray(record.profiles)
    ? record.profiles
        .map((profile) => normalizeClientProfile(profile))
        .filter((profile): profile is ClientProfile => Boolean(profile))
    : []

  const profiles = injectBuiltinEdgeProfiles(rawProfiles)
  const requestedActive = typeof record.activeProfileId === 'string' ? record.activeProfileId : ''
  const activeProfileId = profiles.some((profile) => profile.id === requestedActive)
    ? requestedActive
    : (profiles[0]?.id ?? '')

  const result: AppSettings = {
    clearInputAfterSubmit: booleanSetting(record.clearInputAfterSubmit, false),
    persistInputOnRestart: booleanSetting(record.persistInputOnRestart, true),
    alwaysShowRetryButton: booleanSetting(record.alwaysShowRetryButton, false),
    enterSubmit: booleanSetting(record.enterSubmit, true),
    profiles,
    activeProfileId,
  }
  normalizedSettingsCache.add(result)
  return result
}

export function getActiveApiProfile(settings: Partial<AppSettings> | unknown): ClientProfile {
  const normalized = normalizeSettings(settings)
  return (
    normalized.profiles.find((profile) => profile.id === normalized.activeProfileId) ??
    normalized.profiles[0] ??
    EMPTY_PLATFORM_PROFILE
  )
}

export function getApiProviderLabel(
  _settings: Partial<AppSettings> | unknown,
  kindOrId: string,
): string {
  if (kindOrId === 'gemini' || kindOrId === 'gemini-queue') return 'Gemini'
  if (kindOrId === 'openai' || kindOrId === 'openai-compat' || kindOrId === 'openai-queue') {
    return 'OpenAI'
  }
  return kindOrId
}

export function validateClientProfile(profile: ClientProfile): string | null {
  if (!profile.channelId.trim() || !profile.selectedModelId.trim()) {
    return i18next.t('profile.missingModelId', { ns: 'lib' })
  }
  return null
}

/** 导入只带使用习惯。档案、密钥、自定义端点一律不进来。 */
export function mergeImportedSettings(
  currentSettings: Partial<AppSettings> | unknown,
  importedSettings: Partial<AppSettings> | unknown,
): AppSettings {
  const current = normalizeSettings(currentSettings)
  const imported = isRecord(importedSettings) ? importedSettings : {}
  return normalizeSettings({
    ...current,
    clearInputAfterSubmit: booleanSetting(
      imported.clearInputAfterSubmit,
      current.clearInputAfterSubmit,
    ),
    persistInputOnRestart: booleanSetting(
      imported.persistInputOnRestart,
      current.persistInputOnRestart,
    ),
    alwaysShowRetryButton: booleanSetting(
      imported.alwaysShowRetryButton,
      current.alwaysShowRetryButton,
    ),
    enterSubmit: booleanSetting(imported.enterSubmit, current.enterSubmit),
    profiles: current.profiles,
    activeProfileId: current.activeProfileId,
  })
}

/**
 * 平台渠道的扁平视图。baseUrl 是稳定哨兵（不会被拿去 fetch），apiKey 恒为空：
 * 真正的上游地址和密钥只在 BFF。
 */
export interface ApiProfile {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
  apiProxy: boolean
  responseFormatB64Json?: boolean
  models?: string[]
}

export function clientProfileToApiProfile(profile: ClientProfile): ApiProfile {
  const channel = profile.channelId ? getPublicChannel(profile.channelId) : undefined
  return {
    id: profile.id,
    name: channel?.label ?? profile.channelId,
    provider: channel?.kind === 'gemini-queue' ? 'gemini' : 'openai',
    baseUrl: profile.channelId ? `channel:${profile.channelId}` : '',
    apiKey: '',
    model: profile.selectedModelId,
    timeout: normalizeApiTimeout(channel?.defaults.timeout),
    apiMode: channel?.defaults.apiMode ?? 'images',
    codexCli: channel?.defaults.codexCli ?? false,
    apiProxy: false,
    responseFormatB64Json: channel?.defaults.responseFormatB64Json,
    models: channel?.models.map((model) => model.id),
  }
}

export const DEFAULT_SETTINGS: AppSettings = normalizeSettings({
  profiles: [],
  activeProfileId: '',
  clearInputAfterSubmit: false,
  persistInputOnRestart: true,
  alwaysShowRetryButton: false,
  // 回车即发送：和对话输入框一致，换行用 Shift+Enter。老用户存过的值不动。
  enterSubmit: true,
})
