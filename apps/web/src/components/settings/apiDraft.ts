import {
  type ApiProfile,
  apiProfileToClientProfile,
  clientProfileToApiProfile,
  createDefaultOpenAIByokProfile,
  DEFAULT_API_TIMEOUT,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  findEquivalentClientProfile,
  isBuiltinProfile,
  normalizeSettings,
  switchByokProfileKind,
} from '../../lib/apiProfiles'
import type { ProviderKind, UserByokProfile } from '../../lib/channels/types'
import { isSeedNewProfileName } from '../../lib/profileSeedNames'
import type { AppSettings, CustomProviderDefinition } from '../../types'

/**
 * API 配置表单的草稿。表单仍以扁平的 `ApiProfile` 承载，加载/提交两端各做一次
 * `ClientProfile ↔ ApiProfile` 转换。
 */
export type DraftSettings = Omit<AppSettings, 'profiles'> & { profiles: ApiProfile[] }

export function toDraftSettings(s: AppSettings): DraftSettings {
  return { ...s, profiles: s.profiles.map((p) => clientProfileToApiProfile(p)) }
}

export function fromDraftSettings(d: DraftSettings): AppSettings {
  return { ...d, profiles: d.profiles.map((p) => apiProfileToClientProfile(p)) }
}

export function normalizeDraftSettings(input: unknown): DraftSettings {
  // 调用方混传两种形态：来自 store 的 ClientProfile（有 source 字段）和基于
  // draft 改完的 ApiProfile（扁平、无 source）。normalizeClientProfile 拒收
  // 无 source 的输入，所以如果不在这里先归一化成 ClientProfile，所有 ApiProfile
  // 形态的 profile 会被 normalize 静默吞掉，新建/复制配置就"没反应"。
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    if (Array.isArray(record.profiles)) {
      const normalized = {
        ...record,
        profiles: record.profiles.map((p) =>
          p && typeof p === 'object' && 'source' in p
            ? p
            : apiProfileToClientProfile(p as ApiProfile),
        ),
      }
      return toDraftSettings(normalizeSettings(normalized))
    }
  }
  return toDraftSettings(normalizeSettings(input))
}

export function getActiveDraftProfile(d: DraftSettings): ApiProfile {
  return d.profiles.find((p) => p.id === d.activeProfileId) ?? d.profiles[0]
}

export const DEFAULT_BYOK_BASEURL = createDefaultOpenAIByokProfile().baseUrl

/** 仅在新建 profile 草稿时用：构造一个扁平的 ApiProfile 默认值。 */
export const createDefaultOpenAIProfile = (overrides?: Partial<ApiProfile>): ApiProfile => {
  const byokOverrides: Partial<UserByokProfile> = {}
  if (overrides?.id !== undefined) byokOverrides.id = overrides.id
  if (overrides?.name !== undefined) byokOverrides.name = overrides.name
  if (overrides?.baseUrl !== undefined) byokOverrides.baseUrl = overrides.baseUrl
  if (overrides?.apiKey !== undefined) byokOverrides.apiKey = overrides.apiKey
  if (overrides?.model !== undefined) {
    byokOverrides.selectedModelId = overrides.model
    byokOverrides.models = [overrides.model]
  }
  if (overrides) {
    byokOverrides.preferences = {
      apiMode: overrides.apiMode ?? 'images',
      timeout: overrides.timeout ?? DEFAULT_API_TIMEOUT,
      codexCli: overrides.codexCli ?? false,
      apiProxy: overrides.apiProxy ?? false,
      responseFormatB64Json: overrides.responseFormatB64Json,
    }
  }
  return clientProfileToApiProfile(createDefaultOpenAIByokProfile(byokOverrides))
}

export function isOpenAICompatibleProvider(
  settings: Partial<AppSettings> | unknown,
  provider: string,
): boolean {
  if (provider === 'openai' || provider === 'openai-compat') return true
  const normalized = normalizeSettings(settings)
  return normalized.customProviders.some((p) => p.id === provider)
}

export function findEquivalentApiProfile(
  settings: Partial<AppSettings> | unknown,
  importedProfile: ApiProfile,
): ApiProfile | null {
  const found = findEquivalentClientProfile(settings, apiProfileToClientProfile(importedProfile))
  return found ? clientProfileToApiProfile(found) : null
}

export function switchApiProfileProvider(profile: ApiProfile, provider: string): ApiProfile {
  const kind: ProviderKind = provider === 'gemini' ? 'gemini' : 'openai-compat'
  const clientProfile = apiProfileToClientProfile(profile)
  if (clientProfile.source !== 'user-byok') return profile
  const switched = switchByokProfileKind(clientProfile, kind)
  return clientProfileToApiProfile(switched)
}

/** 通过 id 命中已知 channel 来判定 builtin（与 apiProfileToClientProfile 的判定一致）。 */
export function isBuiltinDraftProfile(p: ApiProfile): boolean {
  return isBuiltinProfile(apiProfileToClientProfile(p))
}

export function getDefaultModelForMode(apiMode: 'images' | 'responses'): string {
  return apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function isPristineNewOpenAIProfile(profile: ApiProfile): boolean {
  const defaultProfile = createDefaultOpenAIProfile({ id: profile.id, name: profile.name })
  return (
    isSeedNewProfileName(profile.name) &&
    profile.provider === 'openai' &&
    profile.baseUrl === defaultProfile.baseUrl &&
    profile.apiKey === '' &&
    profile.model === DEFAULT_IMAGES_MODEL &&
    profile.timeout === DEFAULT_API_TIMEOUT &&
    profile.apiMode === 'images' &&
    profile.codexCli === false &&
    profile.apiProxy === defaultProfile.apiProxy
  )
}

export function getImportedProfileFromMergedSettings(
  nextSettings: AppSettings,
  previousProfileIds: Set<string>,
  importedSettings: { customProviders: CustomProviderDefinition[]; profiles: ApiProfile[] },
): ApiProfile {
  const existingProfile = importedSettings.profiles
    .map((profile) => findEquivalentApiProfile(nextSettings, profile))
    .find((profile): profile is ApiProfile => profile != null && previousProfileIds.has(profile.id))
  if (existingProfile) return existingProfile

  const fallback =
    nextSettings.profiles.find((profile) => !previousProfileIds.has(profile.id)) ??
    nextSettings.profiles[0]
  return clientProfileToApiProfile(fallback)
}
