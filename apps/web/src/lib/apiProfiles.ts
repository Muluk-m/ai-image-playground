import type {
  ApiMode,
  AppSettings,
  CustomProviderContentType,
  CustomProviderDefinition,
  CustomProviderFileMapping,
  CustomProviderPollMapping,
  CustomProviderRequestMethod,
  CustomProviderResultMapping,
  CustomProviderSubmitMapping,
  CustomProviderTemplate,
} from '../types'
import { buildEdgeChannelBaseUrl } from './channels/edgeClient'
import { getPublicChannel, getPublicChannels } from './channels/publicChannels'
import type {
  BuiltinEdgeProfile,
  ClientProfile,
  ProviderKind,
  UserByokPreferences,
  UserByokProfile,
} from './channels/types'
import { readRuntimeEnv } from './runtimeEnv'

// ===== 常量 =====

const DEFAULT_BASE_URL =
  readRuntimeEnv(import.meta.env.VITE_DEFAULT_API_URL) || 'https://api.openai.com/v1'
const DEFAULT_OPENAI_API_PROXY = readRuntimeEnv(import.meta.env.VITE_API_PROXY_AVAILABLE) === 'true'

export const DEFAULT_IMAGES_MODEL = 'gpt-image-2'
export const DEFAULT_RESPONSES_MODEL = 'gpt-5.5'
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-image'
export const DEFAULT_OPENAI_PROFILE_ID = 'default-openai'
export const DEFAULT_API_TIMEOUT = 600

const BUILT_IN_PROVIDER_IDS = new Set<string>(['openai', 'gemini', 'openai-compat'])

const DEFAULT_CUSTOM_PROVIDER_PATHS = {
  generationPath: 'images/generations',
  editPath: 'images/edits',
  taskPath: 'images/tasks/{task_id}',
}
const DEFAULT_GENERATE_BODY = {
  model: '$profile.model',
  prompt: '$prompt',
  size: '$params.size',
  quality: '$params.quality',
  output_format: '$params.output_format',
  moderation: '$params.moderation',
  output_compression: '$params.output_compression',
  n: '$params.n',
}
const DEFAULT_EDIT_BODY = DEFAULT_GENERATE_BODY
const DEFAULT_OPENAI_RESULT: CustomProviderResultMapping = {
  imageUrlPaths: ['data.*.url'],
  b64JsonPaths: ['data.*.b64_json'],
}
const DEFAULT_EDIT_FILES: CustomProviderFileMapping[] = [
  { field: 'image[]', source: 'inputImages', array: true },
  { field: 'mask', source: 'mask' },
]

// ===== Custom provider normalize（与 ClientProfile 解耦，留作 UI 导入/导出能力） =====

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isCustomProviderTemplate(value: unknown): value is CustomProviderTemplate {
  return value === 'http-image'
}

function normalizeProviderPath(value: unknown, fallback: string): string {
  return (typeof value === 'string' && value.trim() ? value : fallback)
    .trim()
    .replace(/^\/+/, '')
    .replace(/^v1\//, '')
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[0] === 'string' && ['string', 'number', 'boolean'].includes(typeof entry[1]),
    )
    .map(([key, item]) => [key, String(item)] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        .map((item) => item.trim())
    : fallback
}

function normalizeRequestMethod(
  value: unknown,
  fallback: CustomProviderRequestMethod = 'POST',
): CustomProviderRequestMethod {
  return value === 'GET' || value === 'POST' ? value : fallback
}

function normalizeContentType(
  value: unknown,
  fallback: CustomProviderContentType = 'json',
): CustomProviderContentType {
  return value === 'multipart' ? 'multipart' : fallback
}

function normalizeBodyTemplate(
  value: unknown,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  return isRecord(value) ? value : fallback
}

function normalizeFileMappings(
  value: unknown,
  fallback: CustomProviderFileMapping[] = [],
): CustomProviderFileMapping[] {
  if (!Array.isArray(value)) return fallback
  const files = value
    .map((item): CustomProviderFileMapping | null => {
      if (!isRecord(item) || typeof item.field !== 'string' || !item.field.trim()) return null
      if (item.source !== 'inputImages' && item.source !== 'mask') return null
      return {
        field: item.field.trim(),
        source: item.source,
        array: Boolean(item.array),
      }
    })
    .filter((item): item is CustomProviderFileMapping => Boolean(item))
  return files.length ? files : fallback
}

function normalizeResultMapping(
  value: unknown,
  fallback: CustomProviderResultMapping = DEFAULT_OPENAI_RESULT,
): CustomProviderResultMapping {
  const record = isRecord(value) ? value : {}
  return {
    imageUrlPaths: normalizeStringArray(record.imageUrlPaths, fallback.imageUrlPaths ?? []),
    b64JsonPaths: normalizeStringArray(record.b64JsonPaths, fallback.b64JsonPaths ?? []),
  }
}

function normalizeSubmitMapping(
  value: unknown,
  fallback: CustomProviderSubmitMapping,
): CustomProviderSubmitMapping {
  const record = isRecord(value) ? value : {}
  const contentType = normalizeContentType(record.contentType, fallback.contentType ?? 'json')
  return {
    path: normalizeProviderPath(record.path, fallback.path),
    method: normalizeRequestMethod(record.method, fallback.method ?? 'POST'),
    contentType,
    query: normalizeStringRecord(record.query) ?? fallback.query,
    body: normalizeBodyTemplate(
      record.body,
      fallback.body ?? (contentType === 'multipart' ? DEFAULT_EDIT_BODY : DEFAULT_GENERATE_BODY),
    ),
    files:
      contentType === 'multipart' ? normalizeFileMappings(record.files, fallback.files) : undefined,
    taskIdPath:
      typeof record.taskIdPath === 'string' && record.taskIdPath.trim()
        ? record.taskIdPath.trim()
        : fallback.taskIdPath,
    result: normalizeResultMapping(record.result, fallback.result ?? DEFAULT_OPENAI_RESULT),
  }
}

function normalizePollMapping(
  value: unknown,
  fallback?: CustomProviderPollMapping,
): CustomProviderPollMapping | undefined {
  if (!isRecord(value) && !fallback) return undefined
  const record = isRecord(value) ? value : {}
  const path = normalizeProviderPath(
    record.path,
    fallback?.path ?? DEFAULT_CUSTOM_PROVIDER_PATHS.taskPath,
  )
  const statusPath =
    typeof record.statusPath === 'string' && record.statusPath.trim()
      ? record.statusPath.trim()
      : fallback?.statusPath
  if (!statusPath) return undefined

  return {
    path,
    method: normalizeRequestMethod(record.method, fallback?.method ?? 'GET'),
    query: normalizeStringRecord(record.query) ?? fallback?.query,
    intervalSeconds:
      typeof record.intervalSeconds === 'number' && Number.isFinite(record.intervalSeconds)
        ? Math.max(1, record.intervalSeconds)
        : (fallback?.intervalSeconds ?? 5),
    statusPath,
    successValues: normalizeStringArray(
      record.successValues,
      fallback?.successValues ?? ['SUCCESS', 'succeeded', 'completed', 'COMPLETED'],
    ),
    failureValues: normalizeStringArray(
      record.failureValues,
      fallback?.failureValues ?? ['FAILURE', 'failed', 'error', 'FAILED', 'cancelled'],
    ),
    errorPath:
      typeof record.errorPath === 'string' && record.errorPath.trim()
        ? record.errorPath.trim()
        : fallback?.errorPath,
    result: normalizeResultMapping(record.result, fallback?.result ?? DEFAULT_OPENAI_RESULT),
  }
}

function legacyCustomProviderToManifest(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  if (record.template !== 'openai-compatible' && record.template !== 'openai-compatible-async')
    return null
  const isAsync = record.template === 'openai-compatible-async'
  const taskResultPath =
    typeof record.taskResultPath === 'string' && record.taskResultPath.trim()
      ? record.taskResultPath.trim()
      : 'data.data'
  return {
    id: record.id,
    name: record.name,
    template: 'http-image',
    submit: {
      path: record.generationPath ?? DEFAULT_CUSTOM_PROVIDER_PATHS.generationPath,
      method: 'POST',
      contentType: 'json',
      query: isAsync ? (normalizeStringRecord(record.submitQuery) ?? { async: 'true' }) : undefined,
      body: DEFAULT_GENERATE_BODY,
      taskIdPath: isAsync ? (record.taskIdPath ?? 'data') : undefined,
      result: DEFAULT_OPENAI_RESULT,
    },
    editSubmit: {
      path: record.editPath ?? DEFAULT_CUSTOM_PROVIDER_PATHS.editPath,
      method: 'POST',
      contentType: 'multipart',
      query: isAsync ? (normalizeStringRecord(record.submitQuery) ?? { async: 'true' }) : undefined,
      body: DEFAULT_EDIT_BODY,
      files: DEFAULT_EDIT_FILES,
      taskIdPath: isAsync ? (record.taskIdPath ?? 'data') : undefined,
      result: DEFAULT_OPENAI_RESULT,
    },
    poll: isAsync
      ? {
          path: record.taskPath ?? DEFAULT_CUSTOM_PROVIDER_PATHS.taskPath,
          method: 'GET',
          statusPath: record.taskStatusPath ?? 'data.status',
          successValues: normalizeStringArray(record.taskSuccessValues, [
            'SUCCESS',
            'succeeded',
            'completed',
            'COMPLETED',
          ]),
          failureValues: normalizeStringArray(record.taskFailureValues, [
            'FAILURE',
            'failed',
            'error',
            'FAILED',
          ]),
          errorPath: 'data.fail_reason',
          intervalSeconds:
            typeof record.pollIntervalSeconds === 'number' ? record.pollIntervalSeconds : 5,
          result: {
            imageUrlPaths: [`${taskResultPath}.data.*.url`],
            b64JsonPaths: [`${taskResultPath}.data.*.b64_json`],
          },
        }
      : undefined,
  }
}

function createCustomProviderId(name: string, usedIds: Set<string>): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'custom'
  let id = `custom-${slug}`
  let index = 2
  while (usedIds.has(id) || BUILT_IN_PROVIDER_IDS.has(id)) {
    id = `custom-${slug}-${index}`
    index += 1
  }
  usedIds.add(id)
  return id
}

export function normalizeCustomProviderDefinition(
  input: unknown,
  usedIds = new Set<string>(),
): CustomProviderDefinition | null {
  if (!input || typeof input !== 'object') return null
  const rawRecord = input as Record<string, unknown>
  const record = legacyCustomProviderToManifest(rawRecord) ?? rawRecord
  const template =
    record.template == null
      ? 'http-image'
      : isCustomProviderTemplate(record.template)
        ? record.template
        : null
  if (!template || !isRecord(record.submit)) return null

  const rawName =
    typeof record.name === 'string' && record.name.trim() ? record.name.trim() : '自定义服务商'
  const id =
    typeof record.id === 'string' &&
    record.id.trim() &&
    !BUILT_IN_PROVIDER_IDS.has(record.id.trim()) &&
    !usedIds.has(record.id.trim())
      ? record.id.trim()
      : createCustomProviderId(rawName, usedIds)
  usedIds.add(id)

  return {
    id,
    name: rawName,
    template,
    submit: normalizeSubmitMapping(record.submit, {
      path: DEFAULT_CUSTOM_PROVIDER_PATHS.generationPath,
      method: 'POST',
      contentType: 'json',
      body: DEFAULT_GENERATE_BODY,
      result: DEFAULT_OPENAI_RESULT,
    }),
    editSubmit: isRecord(record.editSubmit)
      ? normalizeSubmitMapping(record.editSubmit, {
          path: DEFAULT_CUSTOM_PROVIDER_PATHS.editPath,
          method: 'POST',
          contentType: 'multipart',
          body: DEFAULT_EDIT_BODY,
          files: DEFAULT_EDIT_FILES,
          result: DEFAULT_OPENAI_RESULT,
        })
      : undefined,
    poll: normalizePollMapping(record.poll),
  }
}

export function normalizeCustomProviderDefinitions(input: unknown): CustomProviderDefinition[] {
  const usedIds = new Set<string>()
  const list = Array.isArray(input) ? input : []
  return list
    .map((item) => normalizeCustomProviderDefinition(item, usedIds))
    .filter((item): item is CustomProviderDefinition => Boolean(item))
}

// ===== ClientProfile factories =====

export function createDefaultByokPreferences(
  overrides: Partial<UserByokPreferences> = {},
): UserByokPreferences {
  return {
    apiMode: 'images',
    timeout: DEFAULT_API_TIMEOUT,
    codexCli: false,
    apiProxy: DEFAULT_OPENAI_API_PROXY,
    ...overrides,
  }
}

export function createDefaultOpenAIByokProfile(
  overrides: Partial<UserByokProfile> = {},
): UserByokProfile {
  return {
    id: DEFAULT_OPENAI_PROFILE_ID,
    source: 'user-byok',
    name: '默认',
    kind: 'openai-compat',
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
    models: [DEFAULT_IMAGES_MODEL],
    selectedModelId: DEFAULT_IMAGES_MODEL,
    preferences: createDefaultByokPreferences(),
    ...overrides,
  }
}

export function createDefaultGeminiByokProfile(
  overrides: Partial<UserByokProfile> = {},
): UserByokProfile {
  return {
    id: `gemini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'user-byok',
    name: '新配置',
    kind: 'gemini',
    baseUrl: DEFAULT_GEMINI_BASE_URL,
    apiKey: '',
    models: [DEFAULT_GEMINI_MODEL],
    selectedModelId: DEFAULT_GEMINI_MODEL,
    preferences: createDefaultByokPreferences({ apiProxy: false }),
    ...overrides,
  }
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

// ===== ClientProfile normalize =====

function normalizeByokPreferences(
  record: Record<string, unknown>,
  kind: ProviderKind,
): UserByokPreferences {
  return {
    apiMode: record.apiMode === 'responses' ? 'responses' : 'images',
    timeout:
      typeof record.timeout === 'number' && Number.isFinite(record.timeout)
        ? record.timeout
        : DEFAULT_API_TIMEOUT,
    codexCli: kind === 'gemini' ? false : Boolean(record.codexCli),
    apiProxy:
      kind === 'gemini'
        ? false
        : typeof record.apiProxy === 'boolean'
          ? record.apiProxy
          : DEFAULT_OPENAI_API_PROXY,
    responseFormatB64Json: record.responseFormatB64Json === true ? true : undefined,
  }
}

function normalizeProviderKind(value: unknown): ProviderKind {
  if (value === 'gemini') return 'gemini'
  if (value === 'http-template') return 'http-template'
  return 'openai-compat'
}

export function normalizeClientProfile(input: unknown): ClientProfile | null {
  if (!isRecord(input)) return null

  if (input.source === 'builtin-edge') {
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

  if (input.source !== 'user-byok') return null

  const kind = normalizeProviderKind(input.kind)
  const name = typeof input.name === 'string' && input.name.trim() ? input.name : '新配置'
  const id =
    typeof input.id === 'string' && input.id.trim()
      ? input.id
      : `byok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  const baseUrl =
    typeof input.baseUrl === 'string' && input.baseUrl
      ? input.baseUrl
      : kind === 'gemini'
        ? DEFAULT_GEMINI_BASE_URL
        : DEFAULT_BASE_URL
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey : ''

  const rawModels = Array.isArray(input.models)
    ? input.models
        .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        .map((m) => m.trim())
    : []
  const defaultModel = kind === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_IMAGES_MODEL
  const models = rawModels.length ? Array.from(new Set(rawModels)) : [defaultModel]

  const rawSelected =
    typeof input.selectedModelId === 'string' && input.selectedModelId.trim()
      ? input.selectedModelId.trim()
      : ''
  const selectedModelId = models.includes(rawSelected) ? rawSelected : models[0]

  const preferences = normalizeByokPreferences(
    isRecord(input.preferences) ? input.preferences : {},
    kind,
  )

  return {
    id,
    source: 'user-byok',
    name,
    kind,
    baseUrl,
    apiKey,
    models,
    selectedModelId,
    preferences,
  }
}

// ===== Builtin-edge profile 注入 =====

function injectBuiltinEdgeProfiles(userProfiles: ClientProfile[]): ClientProfile[] {
  const channels = getPublicChannels()
  const existingByChannelId = new Map(
    userProfiles
      .filter((p): p is BuiltinEdgeProfile => p.source === 'builtin-edge')
      .map((p) => [p.channelId, p]),
  )

  const builtinProfiles: BuiltinEdgeProfile[] = []
  for (const channel of channels) {
    if (!channel.models.length) continue
    const existing = existingByChannelId.get(channel.id)
    if (existing && channel.models.some((m) => m.id === existing.selectedModelId)) {
      builtinProfiles.push(existing)
    } else {
      builtinProfiles.push(createBuiltinEdgeProfile(channel.id, channel.models[0].id))
    }
  }

  const userByokProfiles = userProfiles.filter(
    (p): p is UserByokProfile => p.source === 'user-byok',
  )
  return [...builtinProfiles, ...userByokProfiles]
}

// ===== normalizeSettings =====

// 已经经过 normalizeSettings 的对象短路返回自身，避免 store / UI / dispatch 路径上的重复正规化。
const normalizedSettingsCache = new WeakSet<AppSettings>()

export function normalizeSettings(input: Partial<AppSettings> | unknown): AppSettings {
  if (input && typeof input === 'object' && normalizedSettingsCache.has(input as AppSettings)) {
    return input as AppSettings
  }
  const record = isRecord(input) ? input : {}
  const customProviders = normalizeCustomProviderDefinitions(record.customProviders)

  const rawProfiles = Array.isArray(record.profiles)
    ? record.profiles
        .map((p) => normalizeClientProfile(p))
        .filter((p): p is ClientProfile => Boolean(p))
    : []

  const profiles = injectBuiltinEdgeProfiles(rawProfiles)
  const profilesWithFallback = profiles.length ? profiles : [createDefaultOpenAIByokProfile()]

  const requestedActive = typeof record.activeProfileId === 'string' ? record.activeProfileId : ''
  const activeProfileId = profilesWithFallback.some((p) => p.id === requestedActive)
    ? requestedActive
    : profilesWithFallback[0].id

  const result: AppSettings = {
    customProviders,
    providerOrder: Array.isArray(record.providerOrder)
      ? record.providerOrder.map(String)
      : undefined,
    clearInputAfterSubmit:
      typeof record.clearInputAfterSubmit === 'boolean' ? record.clearInputAfterSubmit : false,
    persistInputOnRestart:
      typeof record.persistInputOnRestart === 'boolean' ? record.persistInputOnRestart : true,
    reuseTaskApiProfileTemporarily:
      typeof record.reuseTaskApiProfileTemporarily === 'boolean'
        ? record.reuseTaskApiProfileTemporarily
        : false,
    alwaysShowRetryButton:
      typeof record.alwaysShowRetryButton === 'boolean' ? record.alwaysShowRetryButton : false,
    enterSubmit: typeof record.enterSubmit === 'boolean' ? record.enterSubmit : false,
    profiles: profilesWithFallback,
    activeProfileId,
  }
  normalizedSettingsCache.add(result)
  return result
}

// ===== Active profile / labels =====

export function getActiveApiProfile(settings: Partial<AppSettings> | unknown): ClientProfile {
  const normalized = normalizeSettings(settings)
  return (
    normalized.profiles.find((p) => p.id === normalized.activeProfileId) ?? normalized.profiles[0]
  )
}

export function getCustomProviderDefinition(
  settings: Partial<AppSettings> | unknown,
  providerId: string,
): CustomProviderDefinition | null {
  const normalized = normalizeSettings(settings)
  return normalized.customProviders.find((item) => item.id === providerId) ?? null
}

export function getProviderKindLabel(kind: ProviderKind): string {
  if (kind === 'gemini') return 'Gemini'
  if (kind === 'openai-compat') return 'OpenAI'
  return 'HTTP 模板'
}

export function getApiProviderLabel(
  settings: Partial<AppSettings> | unknown,
  kindOrCustomId: string,
): string {
  if (kindOrCustomId === 'gemini') return 'Gemini'
  if (kindOrCustomId === 'openai' || kindOrCustomId === 'openai-compat') return 'OpenAI'
  return getCustomProviderDefinition(settings, kindOrCustomId)?.name ?? kindOrCustomId
}

// ===== validate =====

export function validateClientProfile(profile: ClientProfile): string | null {
  if (profile.source === 'builtin-edge') {
    if (!profile.selectedModelId.trim()) return '缺少模型 ID'
    return null
  }
  if (!profile.name.trim()) return '缺少名称'
  if (!profile.baseUrl.trim()) return '缺少 API URL'
  if (!profile.apiKey.trim()) return '缺少 API Key'
  if (!profile.selectedModelId.trim()) return '缺少模型 ID'
  return null
}

// ===== switch kind =====

export function switchByokProfileKind(
  profile: UserByokProfile,
  kind: ProviderKind,
): UserByokProfile {
  if (profile.kind === kind) return profile

  if (kind === 'gemini') {
    return {
      ...profile,
      kind,
      baseUrl: DEFAULT_GEMINI_BASE_URL,
      models: [DEFAULT_GEMINI_MODEL],
      selectedModelId: DEFAULT_GEMINI_MODEL,
      preferences: {
        ...profile.preferences,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
        responseFormatB64Json: undefined,
      },
    }
  }

  const models = profile.models.length ? profile.models : [DEFAULT_IMAGES_MODEL]
  return {
    ...profile,
    kind: kind === 'http-template' ? 'http-template' : 'openai-compat',
    baseUrl: profile.baseUrl || DEFAULT_BASE_URL,
    models,
    selectedModelId: models.includes(profile.selectedModelId) ? profile.selectedModelId : models[0],
    preferences: profile.preferences,
  }
}

// ===== dedup / merge =====

function getByokDedupKey(profile: UserByokProfile): string {
  return JSON.stringify([
    profile.kind,
    profile.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
    profile.apiKey.trim(),
    profile.selectedModelId.trim(),
    profile.preferences.apiMode,
  ])
}

function getByokConnectionKey(profile: UserByokProfile): string {
  return JSON.stringify([
    profile.kind,
    profile.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
    profile.selectedModelId.trim(),
    profile.preferences.apiMode,
  ])
}

export function findEquivalentClientProfile(
  settings: Partial<AppSettings> | unknown,
  candidate: ClientProfile,
): ClientProfile | null {
  const normalized = normalizeSettings(settings)
  if (candidate.source === 'builtin-edge') {
    return (
      normalized.profiles.find(
        (p): p is BuiltinEdgeProfile =>
          p.source === 'builtin-edge' && p.channelId === candidate.channelId,
      ) ?? null
    )
  }
  const dedupKey = getByokDedupKey(candidate)
  const exact = normalized.profiles.find(
    (p): p is UserByokProfile => p.source === 'user-byok' && getByokDedupKey(p) === dedupKey,
  )
  if (exact) return exact
  if (candidate.apiKey.trim()) return null
  const connKey = getByokConnectionKey(candidate)
  return (
    normalized.profiles.find(
      (p): p is UserByokProfile => p.source === 'user-byok' && getByokConnectionKey(p) === connKey,
    ) ?? null
  )
}

function hasOnlyDefaultProfile(settings: AppSettings): boolean {
  const byok = settings.profiles.filter((p): p is UserByokProfile => p.source === 'user-byok')
  if (byok.length !== 1) return false
  if (settings.customProviders.length) return false
  const only = byok[0]
  return (
    only.id === DEFAULT_OPENAI_PROFILE_ID &&
    only.apiKey === '' &&
    only.kind === 'openai-compat' &&
    only.baseUrl === DEFAULT_BASE_URL &&
    only.selectedModelId === DEFAULT_IMAGES_MODEL
  )
}

function createImportedProfileId(kind: ProviderKind, usedIds: Set<string>): string {
  let id = `${kind}-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  while (usedIds.has(id)) {
    id = `${kind}-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }
  usedIds.add(id)
  return id
}

function dedupeByokProfiles(profiles: UserByokProfile[]): UserByokProfile[] {
  const seen = new Set<string>()
  return profiles.filter((p) => {
    const key = getByokDedupKey(p)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function getCustomProviderDedupKey(provider: CustomProviderDefinition): string {
  return JSON.stringify([
    provider.name,
    provider.template ?? 'http-image',
    provider.submit,
    provider.editSubmit ?? null,
    provider.poll ?? null,
  ])
}

function mergeImportedCustomProviders(
  current: CustomProviderDefinition[],
  imported: CustomProviderDefinition[],
): CustomProviderDefinition[] {
  const providers = [...current]
  const usedIds = new Set(providers.map((p) => p.id))
  const existingKeys = new Map(providers.map((p) => [getCustomProviderDedupKey(p), p.id] as const))

  for (const provider of imported) {
    if (existingKeys.has(getCustomProviderDedupKey(provider))) continue
    const normalized = normalizeCustomProviderDefinition(provider, usedIds)
    if (!normalized) continue
    providers.push(normalized)
    existingKeys.set(getCustomProviderDedupKey(normalized), normalized.id)
  }
  return providers
}

export function mergeImportedSettings(
  currentSettings: Partial<AppSettings> | unknown,
  importedSettings: Partial<AppSettings> | unknown,
): AppSettings {
  const current = normalizeSettings(currentSettings)
  const importedRaw = normalizeSettings(importedSettings)
  const importedByok = dedupeByokProfiles(
    importedRaw.profiles.filter((p): p is UserByokProfile => p.source === 'user-byok'),
  )
  const imported: AppSettings = {
    ...importedRaw,
    profiles: [...importedRaw.profiles.filter((p) => p.source === 'builtin-edge'), ...importedByok],
  }

  if (hasOnlyDefaultProfile(current)) {
    return imported
  }

  const currentByok = current.profiles.filter((p): p is UserByokProfile => p.source === 'user-byok')
  const usedIds = new Set(current.profiles.map((p) => p.id))
  const existingKeys = new Set(currentByok.map(getByokDedupKey))

  const customProviders = mergeImportedCustomProviders(
    current.customProviders,
    imported.customProviders,
  )

  const newByok = importedByok
    .filter((p) => !existingKeys.has(getByokDedupKey(p)))
    .map((p) => {
      if (!usedIds.has(p.id)) {
        usedIds.add(p.id)
        return p
      }
      return { ...p, id: createImportedProfileId(p.kind, usedIds) }
    })

  return normalizeSettings({
    ...current,
    customProviders,
    profiles: [...currentByok, ...newByok],
    activeProfileId: current.activeProfileId,
  })
}

// ===== Import helpers（UI 自定义服务商 JSON 导入入口）=====

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/)
  return match ? match[1].trim() : trimmed
}

export interface ImportedProviderSettings {
  customProviders: CustomProviderDefinition[]
  profiles: ClientProfile[]
}

function validateImportedProfileRecord(input: unknown) {
  if (!isRecord(input)) return
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  if (baseUrl && (baseUrl.startsWith('[') || baseUrl.includes(']('))) {
    throw new Error('JSON 包含 Markdown 链接，请粘贴纯文本')
  }
  if (
    typeof input.apiMode === 'string' &&
    input.apiMode !== 'images' &&
    input.apiMode !== 'responses'
  ) {
    throw new Error('apiMode 格式无效，应为 images 或 responses')
  }
}

/** 从旧 ApiProfile 形态（含 provider/model 字段）派生 UserByokProfile，专用于 import 路径。 */
function legacyProfileRecordToByok(record: Record<string, unknown>): UserByokProfile | null {
  const kind: ProviderKind = record.provider === 'gemini' ? 'gemini' : 'openai-compat'
  const baseUrl =
    typeof record.baseUrl === 'string' && record.baseUrl
      ? record.baseUrl
      : kind === 'gemini'
        ? DEFAULT_GEMINI_BASE_URL
        : DEFAULT_BASE_URL
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey : ''
  const name = typeof record.name === 'string' && record.name.trim() ? record.name : '导入配置'
  const model =
    typeof record.model === 'string' && record.model.trim()
      ? record.model.trim()
      : kind === 'gemini'
        ? DEFAULT_GEMINI_MODEL
        : DEFAULT_IMAGES_MODEL
  const id =
    typeof record.id === 'string' && record.id.trim()
      ? record.id
      : `byok-import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  return {
    id,
    source: 'user-byok',
    name,
    kind,
    baseUrl,
    apiKey,
    models: [model],
    selectedModelId: model,
    preferences: normalizeByokPreferences(record, kind),
  }
}

export function importCustomProviderSettingsFromJson(
  jsonText: string,
  existingProviders: CustomProviderDefinition[] = [],
): ImportedProviderSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripMarkdownCodeFence(jsonText))
  } catch {
    throw new Error('JSON 格式无效')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON 根节点必须是对象')
  }
  const record = parsed as Record<string, unknown>

  if (Array.isArray(record.customProviders)) {
    const customProviders = normalizeCustomProviderDefinitions(record.customProviders)
    if (customProviders.length === 0) {
      throw new Error('customProviders 数组中没有有效的服务商配置')
    }
    const profiles: ClientProfile[] = Array.isArray(record.profiles)
      ? record.profiles
          .map((item) => {
            validateImportedProfileRecord(item)
            return item
          })
          .map((item) =>
            isRecord(item) && item.source === 'user-byok'
              ? normalizeClientProfile(item)
              : isRecord(item)
                ? legacyProfileRecordToByok(item)
                : null,
          )
          .filter((p): p is ClientProfile => Boolean(p))
      : []
    return { customProviders, profiles }
  }

  const usedIds = new Set(existingProviders.map((p) => p.id))
  const direct = normalizeCustomProviderDefinition(parsed, usedIds)
  if (direct) return { customProviders: [direct], profiles: [] }

  throw new Error('无法识别该 JSON。请粘贴自定义服务商配置。')
}

export function importCustomProviderDefinitionFromJson(
  jsonText: string,
  existingProviders: CustomProviderDefinition[] = [],
): CustomProviderDefinition {
  const result = importCustomProviderSettingsFromJson(jsonText, existingProviders)
  return result.customProviders[0]
}

// ===== Flat ApiProfile view =====
// ClientProfile 的扁平视图，给以 dedup-key / task-match / settings 表单为代表的扁平场景使用。
// builtin-edge profile 的 baseUrl 是 edge proxy 路径，apiKey 始终为空。

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

function kindToLegacyProvider(kind: ProviderKind): string {
  if (kind === 'gemini') return 'gemini'
  return 'openai'
}

function legacyProviderToKind(provider: string): ProviderKind {
  if (provider === 'gemini') return 'gemini'
  return 'openai-compat'
}

export function clientProfileToApiProfile(profile: ClientProfile): ApiProfile {
  if (profile.source === 'builtin-edge') {
    const channel = getPublicChannel(profile.channelId)
    return {
      id: profile.id,
      name: channel?.label ?? profile.channelId,
      provider: channel?.kind === 'gemini' ? 'gemini' : 'openai',
      // 让 baseUrl 取边缘代理前缀，使 codexCli prompt key 等以 baseUrl 为身份的逻辑能区分不同 builtin channel。
      baseUrl: buildEdgeChannelBaseUrl(profile.channelId),
      apiKey: '',
      model: profile.selectedModelId,
      timeout: channel?.defaults.timeout ?? DEFAULT_API_TIMEOUT,
      apiMode: channel?.defaults.apiMode ?? 'images',
      codexCli: channel?.defaults.codexCli ?? false,
      apiProxy: false,
      responseFormatB64Json: channel?.defaults.responseFormatB64Json,
      models: channel?.models.map((m) => m.id),
    }
  }
  return {
    id: profile.id,
    name: profile.name,
    provider: kindToLegacyProvider(profile.kind),
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.selectedModelId,
    timeout: profile.preferences.timeout,
    apiMode: profile.preferences.apiMode,
    codexCli: profile.preferences.codexCli,
    apiProxy: profile.preferences.apiProxy,
    responseFormatB64Json: profile.preferences.responseFormatB64Json,
    models: profile.models,
  }
}

export function apiProfileToClientProfile(profile: ApiProfile): ClientProfile {
  // 如果 id 命中已知 channel，恢复为 builtin-edge 形态以保留 source 语义。
  const channel = getPublicChannel(profile.id)
  if (channel) {
    const validModel = channel.models.some((m) => m.id === profile.model)
      ? profile.model
      : (channel.models[0]?.id ?? profile.model)
    return {
      id: profile.id,
      source: 'builtin-edge',
      channelId: profile.id,
      selectedModelId: validModel,
    }
  }
  const kind = legacyProviderToKind(profile.provider)
  const models = profile.models && profile.models.length ? profile.models : [profile.model]
  return {
    id: profile.id,
    source: 'user-byok',
    name: profile.name,
    kind,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    models,
    selectedModelId: models.includes(profile.model) ? profile.model : models[0],
    preferences: {
      apiMode: profile.apiMode,
      timeout: profile.timeout,
      codexCli: profile.codexCli,
      apiProxy: profile.apiProxy,
      responseFormatB64Json: profile.responseFormatB64Json,
    },
  }
}

export function isBuiltinProfile(
  profile: ClientProfile | null | undefined,
): profile is BuiltinEdgeProfile {
  return profile?.source === 'builtin-edge'
}

// ===== DEFAULT_SETTINGS =====

export const DEFAULT_SETTINGS: AppSettings = normalizeSettings({
  customProviders: [],
  profiles: [],
  activeProfileId: '',
  clearInputAfterSubmit: false,
  persistInputOnRestart: true,
  reuseTaskApiProfileTemporarily: false,
  alwaysShowRetryButton: false,
  enterSubmit: false,
})
