import type {
  ClientProfile,
  ProviderKind,
  PublicChannel,
  UserByokPreferences,
} from './types'

/**
 * 老 builtin profile id（apiKey 打 bundle 时代） → 新 channelId 映射。
 * 不在映射表中的 builtin- 前缀 profile 会被丢弃。
 */
export const LEGACY_BUILTIN_ID_MAP: Record<string, string> = {
  'builtin-sub2api-gemini': 'qlj-sub2api-gemini-flash-image',
  'builtin-sub2api-gemini-flash-image-preview': 'qlj-sub2api-gemini-flash-image-preview',
}

const DEFAULT_MODEL_BY_KIND: Record<ProviderKind, string> = {
  'openai-compat': 'gpt-image-2',
  'gemini': 'gemini-3.1-flash-image',
  'http-template': '',
}

export interface MigrationResult {
  profiles: ClientProfile[]
  activeProfileId: string
  /** 老 fal profile / 无法映射的 builtin profile 的 id 列表（用于一次性 toast） */
  droppedLegacyIds: string[]
  /** builtinProfileModelSelections 已并入 builtin-edge profile，外层应在迁移后清空该字段 */
  consumedBuiltinModelSelections: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 已是 ClientProfile 形态 → 直接透传（幂等）。 */
function isAlreadyClientProfile(raw: Record<string, unknown>): boolean {
  return raw.source === 'builtin-edge' || raw.source === 'user-byok'
}

function legacyProviderToKind(provider: unknown): ProviderKind | null {
  if (provider === 'gemini') return 'gemini'
  if (provider === 'openai') return 'openai-compat'
  if (typeof provider === 'string' && provider.startsWith('custom-')) return 'openai-compat'
  return null
}

function buildBuiltinEdge(
  rawId: string,
  raw: Record<string, unknown>,
  channelId: string,
  channel: PublicChannel | undefined,
  builtinModelSelections: Record<string, string>,
): ClientProfile {
  const recordedSelection = builtinModelSelections[rawId]
  const channelModelIds = channel ? channel.models.map((m) => m.id) : []
  const rawModel = typeof raw.model === 'string' ? raw.model : ''
  const candidates = [recordedSelection, rawModel].filter(
    (m): m is string => typeof m === 'string' && m.length > 0,
  )
  const valid = candidates.find((m) => channelModelIds.includes(m))
  const selectedModelId = valid ?? channelModelIds[0] ?? ''

  return {
    id: rawId,
    source: 'builtin-edge',
    channelId,
    selectedModelId,
  }
}

function buildUserByok(
  rawId: string,
  raw: Record<string, unknown>,
  kind: ProviderKind,
): ClientProfile {
  const rawModel = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : ''
  const rawModels = Array.isArray(raw.models)
    ? (raw.models as unknown[]).filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    : []

  const merged = Array.from(new Set([rawModel, ...rawModels].filter(Boolean)))
  const models = merged.length > 0 ? merged : [DEFAULT_MODEL_BY_KIND[kind]].filter(Boolean)
  const selectedModelId = rawModel && models.includes(rawModel) ? rawModel : models[0]

  const preferences: UserByokPreferences = {
    apiMode: raw.apiMode === 'responses' ? 'responses' : 'images',
    timeout: typeof raw.timeout === 'number' && raw.timeout > 0 ? raw.timeout : 600,
    codexCli: raw.codexCli === true,
    apiProxy: raw.apiProxy === true,
    responseFormatB64Json: typeof raw.responseFormatB64Json === 'boolean' ? raw.responseFormatB64Json : undefined,
  }

  return {
    id: rawId,
    source: 'user-byok',
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '配置',
    kind,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    models,
    selectedModelId,
    preferences,
  }
}

export function migrateLegacyProfiles(
  rawSettings: unknown,
  publicChannels: PublicChannel[],
): MigrationResult {
  const settings = isRecord(rawSettings) ? rawSettings : {}
  const rawProfiles = Array.isArray(settings.profiles) ? settings.profiles : []
  const builtinModelSelections = isRecord(settings.builtinProfileModelSelections)
    ? (settings.builtinProfileModelSelections as Record<string, string>)
    : {}
  const channelById = new Map(publicChannels.map((c) => [c.id, c]))

  const profiles: ClientProfile[] = []
  const droppedLegacyIds: string[] = []
  let consumedBuiltinModelSelections = Object.keys(builtinModelSelections).length > 0

  for (const item of rawProfiles) {
    if (!isRecord(item)) continue
    const rawId = typeof item.id === 'string' && item.id.trim() ? item.id : `legacy-${profiles.length}`

    if (isAlreadyClientProfile(item)) {
      profiles.push(item as unknown as ClientProfile)
      continue
    }

    if (item.provider === 'fal') {
      droppedLegacyIds.push(rawId)
      continue
    }

    if (typeof rawId === 'string' && rawId.startsWith('builtin-')) {
      const channelId = LEGACY_BUILTIN_ID_MAP[rawId]
      if (!channelId) {
        droppedLegacyIds.push(rawId)
        continue
      }
      profiles.push(
        buildBuiltinEdge(rawId, item, channelId, channelById.get(channelId), builtinModelSelections),
      )
      continue
    }

    const kind = legacyProviderToKind(item.provider)
    if (!kind) {
      droppedLegacyIds.push(rawId)
      continue
    }
    profiles.push(buildUserByok(rawId, item, kind))
  }

  if (profiles.length === 0) {
    consumedBuiltinModelSelections = false
  }

  const rawActiveId = typeof settings.activeProfileId === 'string' ? settings.activeProfileId : ''
  const activeProfileId = profiles.some((p) => p.id === rawActiveId)
    ? rawActiveId
    : profiles[0]?.id ?? ''

  return { profiles, activeProfileId, droppedLegacyIds, consumedBuiltinModelSelections }
}

/** 从老 TaskRecord 中剥离 fal 字段；其他字段透传。 */
export function stripLegacyFalFields<T extends Record<string, unknown>>(record: T): T {
  if (!isRecord(record)) return record
  const { falRequestId: _a, falEndpoint: _b, falRecoverable: _c, ...rest } = record as Record<
    string,
    unknown
  >
  void _a; void _b; void _c
  return rest as T
}
