import type {
  ApiMode,
  ApiProvider,
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
import type { ClientProfile, PublicChannel } from './channels/types'
import { getPublicChannel, getPublicChannels } from './channels/publicChannels'
import { readRuntimeEnv } from './runtimeEnv'

// ===== Legacy ApiProfile view (synthesized from ClientProfile + PublicChannel) =====
//
// 真正的存储是 AppSettings.profiles: ClientProfile[]（discriminated union）。
// 但 UI / store / openai|gemini adapter 仍按旧 ApiProfile 平铺字段写就；本类型作为
// 过渡期的「合成视图」：getActiveApiProfile() 等读路径从 ClientProfile + PublicChannel
// 合成出 ApiProfile 形态喂给上层。下一个子轮 UI 切到 ClientProfile 后此 type 移除。

export interface ApiProfileProviderDraftValue {
  baseUrl?: string
  model?: string
  apiMode?: ApiMode
  codexCli?: boolean
  apiProxy?: boolean
  responseFormatB64Json?: boolean
}

export interface ApiProfile {
  id: string
  name: string
  provider: ApiProvider
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
  apiProxy: boolean
  responseFormatB64Json?: boolean
  models?: string[]
  providerDrafts?: Partial<Record<ApiProvider, ApiProfileProviderDraftValue>>
}

type ApiProfileProviderDraft = ApiProfileProviderDraftValue | undefined

// ===== Constants =====

const DEFAULT_BASE_URL = readRuntimeEnv(import.meta.env.VITE_DEFAULT_API_URL) || 'https://api.openai.com/v1'
const DEFAULT_OPENAI_API_PROXY = readRuntimeEnv(import.meta.env.VITE_API_PROXY_AVAILABLE) === 'true'
export const DEFAULT_IMAGES_MODEL = 'gpt-image-2'
export const DEFAULT_RESPONSES_MODEL = 'gpt-5.5'
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-image'
export const DEFAULT_OPENAI_PROFILE_ID = 'default-openai'
export const DEFAULT_API_TIMEOUT = 600
const BUILT_IN_PROVIDER_IDS = new Set<ApiProvider>(['openai', 'gemini'])

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

function isCustomProviderTemplate(value: unknown): value is CustomProviderTemplate {
  return value === 'http-image'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeProviderPath(value: unknown, fallback: string): string {
  return (typeof value === 'string' && value.trim() ? value : fallback).trim().replace(/^\/+/, '').replace(/^v1\//, '')
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string | number | boolean] =>
      typeof entry[0] === 'string' && ['string', 'number', 'boolean'].includes(typeof entry[1]),
    )
    .map(([key, item]) => [key, String(item)] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : fallback
}

function normalizeRequestMethod(value: unknown, fallback: CustomProviderRequestMethod = 'POST'): CustomProviderRequestMethod {
  return value === 'GET' || value === 'POST' ? value : fallback
}

function normalizeContentType(value: unknown, fallback: CustomProviderContentType = 'json'): CustomProviderContentType {
  return value === 'multipart' ? 'multipart' : fallback
}

function normalizeBodyTemplate(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  return isRecord(value) ? value : fallback
}

function normalizeFileMappings(value: unknown, fallback: CustomProviderFileMapping[] = []): CustomProviderFileMapping[] {
  if (!Array.isArray(value)) return fallback
  const files = value
    .map((item): CustomProviderFileMapping | null => {
      if (!isRecord(item) || typeof item.field !== 'string' || !item.field.trim()) return null
      if (item.source !== 'inputImages' && item.source !== 'mask') return null
      return { field: item.field.trim(), source: item.source, array: Boolean(item.array) }
    })
    .filter((item): item is CustomProviderFileMapping => Boolean(item))
  return files.length ? files : fallback
}

function normalizeResultMapping(value: unknown, fallback: CustomProviderResultMapping = DEFAULT_OPENAI_RESULT): CustomProviderResultMapping {
  const record = isRecord(value) ? value : {}
  const imageUrlPaths = normalizeStringArray(record.imageUrlPaths, fallback.imageUrlPaths ?? [])
  const b64JsonPaths = normalizeStringArray(record.b64JsonPaths, fallback.b64JsonPaths ?? [])
  return { imageUrlPaths, b64JsonPaths }
}

function normalizeSubmitMapping(value: unknown, fallback: CustomProviderSubmitMapping): CustomProviderSubmitMapping {
  const record = isRecord(value) ? value : {}
  const contentType = normalizeContentType(record.contentType, fallback.contentType ?? 'json')
  return {
    path: normalizeProviderPath(record.path, fallback.path),
    method: normalizeRequestMethod(record.method, fallback.method ?? 'POST'),
    contentType,
    query: normalizeStringRecord(record.query) ?? fallback.query,
    body: normalizeBodyTemplate(record.body, fallback.body ?? (contentType === 'multipart' ? DEFAULT_EDIT_BODY : DEFAULT_GENERATE_BODY)),
    files: contentType === 'multipart' ? normalizeFileMappings(record.files, fallback.files) : undefined,
    taskIdPath: typeof record.taskIdPath === 'string' && record.taskIdPath.trim() ? record.taskIdPath.trim() : fallback.taskIdPath,
    result: normalizeResultMapping(record.result, fallback.result ?? DEFAULT_OPENAI_RESULT),
  }
}

function normalizePollMapping(value: unknown, fallback?: CustomProviderPollMapping): CustomProviderPollMapping | undefined {
  if (!isRecord(value) && !fallback) return undefined
  const record = isRecord(value) ? value : {}
  const path = normalizeProviderPath(record.path, fallback?.path ?? DEFAULT_CUSTOM_PROVIDER_PATHS.taskPath)
  const statusPath = typeof record.statusPath === 'string' && record.statusPath.trim() ? record.statusPath.trim() : fallback?.statusPath
  if (!statusPath) return undefined
  return {
    path,
    method: normalizeRequestMethod(record.method, fallback?.method ?? 'GET'),
    query: normalizeStringRecord(record.query) ?? fallback?.query,
    intervalSeconds: typeof record.intervalSeconds === 'number' && Number.isFinite(record.intervalSeconds)
      ? Math.max(1, record.intervalSeconds)
      : fallback?.intervalSeconds ?? 5,
    statusPath,
    successValues: normalizeStringArray(record.successValues, fallback?.successValues ?? ['SUCCESS', 'succeeded', 'completed', 'COMPLETED']),
    failureValues: normalizeStringArray(record.failureValues, fallback?.failureValues ?? ['FAILURE', 'failed', 'error', 'FAILED', 'cancelled']),
    errorPath: typeof record.errorPath === 'string' && record.errorPath.trim() ? record.errorPath.trim() : fallback?.errorPath,
    result: normalizeResultMapping(record.result, fallback?.result ?? DEFAULT_OPENAI_RESULT),
  }
}

function legacyCustomProviderToManifest(record: Record<string, unknown>): Record<string, unknown> | null {
  if (record.template !== 'openai-compatible' && record.template !== 'openai-compatible-async') return null
  const isAsync = record.template === 'openai-compatible-async'
  const taskResultPath = typeof record.taskResultPath === 'string' && record.taskResultPath.trim() ? record.taskResultPath.trim() : 'data.data'
  return {
    id: record.id,
    name: record.name,
    template: 'http-image',
    submit: {
      path: record.generationPath ?? DEFAULT_CUSTOM_PROVIDER_PATHS.generationPath,
      method: 'POST',
      contentType: 'json',
      query: isAsync ? normalizeStringRecord(record.submitQuery) ?? { async: 'true' } : undefined,
      body: DEFAULT_GENERATE_BODY,
      taskIdPath: isAsync ? (record.taskIdPath ?? 'data') : undefined,
      result: DEFAULT_OPENAI_RESULT,
    },
    editSubmit: {
      path: record.editPath ?? DEFAULT_CUSTOM_PROVIDER_PATHS.editPath,
      method: 'POST',
      contentType: 'multipart',
      query: isAsync ? normalizeStringRecord(record.submitQuery) ?? { async: 'true' } : undefined,
      body: DEFAULT_EDIT_BODY,
      files: DEFAULT_EDIT_FILES,
      taskIdPath: isAsync ? (record.taskIdPath ?? 'data') : undefined,
      result: DEFAULT_OPENAI_RESULT,
    },
    poll: isAsync ? {
      path: record.taskPath ?? DEFAULT_CUSTOM_PROVIDER_PATHS.taskPath,
      method: 'GET',
      statusPath: record.taskStatusPath ?? 'data.status',
      successValues: normalizeStringArray(record.taskSuccessValues, ['SUCCESS', 'succeeded', 'completed', 'COMPLETED']),
      failureValues: normalizeStringArray(record.taskFailureValues, ['FAILURE', 'failed', 'error', 'FAILED']),
      errorPath: 'data.fail_reason',
      intervalSeconds: typeof record.pollIntervalSeconds === 'number' ? record.pollIntervalSeconds : 5,
      result: {
        imageUrlPaths: [`${taskResultPath}.data.*.url`],
        b64JsonPaths: [`${taskResultPath}.data.*.b64_json`],
      },
    } : undefined,
  }
}

function createCustomProviderId(name: string, usedIds: Set<string>): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
  let id = `custom-${slug}`
  let index = 2
  while (usedIds.has(id) || BUILT_IN_PROVIDER_IDS.has(id)) {
    id = `custom-${slug}-${index}`
    index += 1
  }
  usedIds.add(id)
  return id
}

export function normalizeCustomProviderDefinition(input: unknown, usedIds = new Set<string>()): CustomProviderDefinition | null {
  if (!input || typeof input !== 'object') return null
  const rawRecord = input as Record<string, unknown>
  const record = legacyCustomProviderToManifest(rawRecord) ?? rawRecord
  const template = record.template == null ? 'http-image' : isCustomProviderTemplate(record.template) ? record.template : null
  if (!template || !isRecord(record.submit)) return null

  const rawName = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : '自定义服务商'
  const id = typeof record.id === 'string' && record.id.trim() && !BUILT_IN_PROVIDER_IDS.has(record.id.trim()) && !usedIds.has(record.id.trim())
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
    editSubmit: isRecord(record.editSubmit) ? normalizeSubmitMapping(record.editSubmit, {
      path: DEFAULT_CUSTOM_PROVIDER_PATHS.editPath,
      method: 'POST',
      contentType: 'multipart',
      body: DEFAULT_EDIT_BODY,
      files: DEFAULT_EDIT_FILES,
      result: DEFAULT_OPENAI_RESULT,
    }) : undefined,
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

// ===== ApiProfile factories (return synthetic view) =====

export function createDefaultOpenAIProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: DEFAULT_OPENAI_PROFILE_ID,
    name: '默认',
    provider: 'openai',
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
    model: DEFAULT_IMAGES_MODEL,
    timeout: DEFAULT_API_TIMEOUT,
    apiMode: 'images',
    codexCli: false,
    apiProxy: DEFAULT_OPENAI_API_PROXY,
    ...overrides,
  }
}

export function createDefaultGeminiProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: `gemini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: '新配置',
    provider: 'gemini',
    baseUrl: DEFAULT_GEMINI_BASE_URL,
    apiKey: '',
    model: DEFAULT_GEMINI_MODEL,
    timeout: DEFAULT_API_TIMEOUT,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    ...overrides,
  }
}

export function switchApiProfileProvider(profile: ApiProfile, provider: ApiProvider, customProvider?: CustomProviderDefinition): ApiProfile {
  const providerDrafts: NonNullable<ApiProfile['providerDrafts']> = {
    ...profile.providerDrafts,
    [profile.provider]: {
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiMode: profile.apiMode,
      codexCli: profile.codexCli,
      apiProxy: profile.apiProxy,
      responseFormatB64Json: profile.responseFormatB64Json,
    },
  }
  const savedDraft = providerDrafts[provider]

  if (provider === 'gemini') {
    return {
      ...profile,
      provider,
      baseUrl: savedDraft?.baseUrl ?? DEFAULT_GEMINI_BASE_URL,
      model: savedDraft?.model ?? DEFAULT_GEMINI_MODEL,
      apiMode: 'images',
      codexCli: false,
      apiProxy: false,
      responseFormatB64Json: undefined,
      providerDrafts,
    }
  }

  if (customProvider) {
    return {
      ...profile,
      provider: customProvider.id,
      baseUrl: savedDraft?.baseUrl ?? (profile.baseUrl || DEFAULT_BASE_URL),
      model: savedDraft?.model ?? (profile.model || DEFAULT_IMAGES_MODEL),
      apiMode: savedDraft?.apiMode ?? 'images',
      codexCli: false,
      apiProxy: false,
      responseFormatB64Json: savedDraft?.responseFormatB64Json,
      providerDrafts,
    }
  }

  return {
    ...profile,
    provider,
    baseUrl: savedDraft?.baseUrl ?? DEFAULT_BASE_URL,
    model: savedDraft?.model ?? DEFAULT_IMAGES_MODEL,
    apiMode: savedDraft?.apiMode ?? profile.apiMode,
    codexCli: savedDraft?.codexCli ?? profile.codexCli,
    apiProxy: savedDraft?.apiProxy ?? DEFAULT_OPENAI_API_PROXY,
    responseFormatB64Json: savedDraft?.responseFormatB64Json,
    providerDrafts,
  }
}

function normalizeProviderDraft(input: unknown, provider: ApiProvider, customProviderIds: Set<string>): ApiProfileProviderDraft {
  if (!isRecord(input)) return undefined
  const fallback = provider === 'gemini' ? createDefaultGeminiProfile() : createDefaultOpenAIProfile()
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : undefined
  const model = typeof input.model === 'string' && input.model.trim() ? input.model : undefined
  const apiMode = input.apiMode === 'responses' ? 'responses' : input.apiMode === 'images' ? 'images' : undefined
  const knownProvider = provider === 'openai' || provider === 'gemini' || customProviderIds.has(provider)
  if (!knownProvider) return undefined

  return {
    baseUrl: provider === 'gemini'
      ? baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_GEMINI_BASE_URL
      : baseUrl,
    model,
    apiMode,
    codexCli: typeof input.codexCli === 'boolean' ? input.codexCli : fallback.codexCli,
    apiProxy: typeof input.apiProxy === 'boolean' ? input.apiProxy : fallback.apiProxy,
    responseFormatB64Json: input.responseFormatB64Json === true ? true : undefined,
  }
}

function normalizeProviderDrafts(input: unknown, customProviderIds: Set<string>): ApiProfile['providerDrafts'] {
  if (!isRecord(input)) return undefined
  const entries = Object.entries(input)
    .map(([provider, draft]) => [provider, normalizeProviderDraft(draft, provider, customProviderIds)] as const)
    .filter((entry): entry is [ApiProvider, NonNullable<ApiProfileProviderDraft>] => Boolean(entry[1]))
  return entries.length ? Object.fromEntries(entries) : undefined
}

export function normalizeApiProfile(input: unknown, fallback?: Partial<ApiProfile>, customProviderIds = new Set<string>()): ApiProfile {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const rawProvider = typeof record.provider === 'string' ? record.provider : ''
  const provider: ApiProvider =
    rawProvider === 'gemini' || customProviderIds.has(rawProvider) ? rawProvider : 'openai'
  const defaults = provider === 'gemini' ? createDefaultGeminiProfile(fallback) : createDefaultOpenAIProfile(fallback)
  const apiMode: ApiMode = record.apiMode === 'responses' ? 'responses' : 'images'
  const rawBaseUrl = typeof record.baseUrl === 'string' ? record.baseUrl : defaults.baseUrl

  return {
    ...defaults,
    id: typeof record.id === 'string' && record.id.trim() ? record.id : defaults.id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name : defaults.name,
    provider,
    baseUrl: provider === 'gemini' ? rawBaseUrl.trim().replace(/\/+$/, '') || DEFAULT_GEMINI_BASE_URL : rawBaseUrl,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : defaults.apiKey,
    model: typeof record.model === 'string' && record.model.trim() ? record.model : defaults.model,
    timeout: typeof record.timeout === 'number' && Number.isFinite(record.timeout) ? record.timeout : defaults.timeout,
    apiMode,
    codexCli: Boolean(record.codexCli),
    apiProxy: typeof record.apiProxy === 'boolean' ? record.apiProxy : defaults.apiProxy,
    responseFormatB64Json: record.responseFormatB64Json === true ? true : undefined,
    models: Array.isArray(record.models)
      ? record.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      : undefined,
    providerDrafts: normalizeProviderDrafts(record.providerDrafts, customProviderIds),
  }
}

function validateImportedProfileRecord(input: unknown) {
  if (!isRecord(input)) return
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  if (baseUrl && (baseUrl.startsWith('[') || baseUrl.includes(']('))) {
    throw new Error('JSON 包含 Markdown 链接，请粘贴纯文本')
  }
  if (typeof input.apiMode === 'string' && input.apiMode !== 'images' && input.apiMode !== 'responses') {
    throw new Error('apiMode 格式无效，应为 images 或 responses')
  }
}

// ===== Bridge: ApiProfile <-> ClientProfile =====

/** Synthesize a legacy ApiProfile view from a ClientProfile + the channel registry. */
export function clientProfileToApiProfile(profile: ClientProfile, publicChannels: PublicChannel[] = getPublicChannels()): ApiProfile {
  if (profile.source === 'builtin-edge') {
    const channel = publicChannels.find((c) => c.id === profile.channelId)
    const kind = channel?.kind ?? 'openai-compat'
    return {
      id: profile.id,
      name: channel?.label ?? profile.channelId,
      provider: kind === 'gemini' ? 'gemini' : 'openai',
      // builtin-edge 永远通过 /api-proxy/<channelId>/<path> 走边缘，apiKey 留在边缘端
      baseUrl: `/api-proxy/${profile.channelId}`,
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
  const provider: ApiProvider = profile.kind === 'gemini' ? 'gemini' : 'openai'
  return {
    id: profile.id,
    name: profile.name,
    provider,
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

/** Convert a legacy ApiProfile-shape record into a ClientProfile for storage. */
export function apiProfileToClientProfile(profile: ApiProfile): ClientProfile {
  // builtin-edge profiles never originate from the UI's ApiProfile flow; only via channels.json.
  // We treat every ApiProfile in this direction as user-byok.
  const kind = profile.provider === 'gemini' ? 'gemini' : 'openai-compat'
  const models = profile.models?.length ? [...profile.models] : [profile.model].filter(Boolean)
  return {
    id: profile.id,
    source: 'user-byok',
    name: profile.name,
    kind,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    models,
    selectedModelId: profile.model || models[0] || '',
    preferences: {
      apiMode: profile.apiMode,
      timeout: profile.timeout,
      codexCli: profile.codexCli,
      apiProxy: profile.apiProxy,
      responseFormatB64Json: profile.responseFormatB64Json,
    },
  }
}

// ===== normalizeSettings =====

export interface NormalizeSettingsOptions {
  /** @deprecated 内置 channel 现在由 config/channels.json 单一来源决定，此选项不再使用。 */
  builtinProfiles?: ApiProfile[]
}

export function normalizeSettings(input: Partial<AppSettings> | unknown, _options: NormalizeSettingsOptions = {}): AppSettings {
  const record = isRecord(input) ? input : {}
  const customProviders = normalizeCustomProviderDefinitions(record.customProviders)
  const customProviderIds = new Set(customProviders.map((p) => p.id))

  // 标准化输入 profiles：支持 ClientProfile-shape（透传）与 ApiProfile-shape（转换）。
  // 不再做"旧 builtin- 前缀 → channelId"映射（无存量用户需要迁移）。
  const rawList = Array.isArray(record.profiles) ? record.profiles : []
  let profiles: ClientProfile[] = []
  for (const item of rawList) {
    if (!isRecord(item)) continue
    if (item.source === 'builtin-edge' || item.source === 'user-byok') {
      profiles.push(item as unknown as ClientProfile)
      continue
    }
    // 视作 ApiProfile-shape 输入，转换为 user-byok ClientProfile。
    const normalized = normalizeApiProfile(item, undefined, customProviderIds)
    profiles.push(apiProfileToClientProfile(normalized))
  }

  // 完全空（既没有新 profiles，也没有顶层 legacy fields 暗示）→ 注入一个默认 OpenAI BYOK
  let activeProfileId = typeof record.activeProfileId === 'string' ? record.activeProfileId : ''
  if (profiles.length === 0) {
    const seed = createDefaultOpenAIProfile({
      baseUrl: typeof record.baseUrl === 'string' && record.baseUrl ? record.baseUrl : DEFAULT_BASE_URL,
      apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
      model: typeof record.model === 'string' && record.model.trim() ? record.model : DEFAULT_IMAGES_MODEL,
      timeout: typeof record.timeout === 'number' && Number.isFinite(record.timeout) ? record.timeout : DEFAULT_API_TIMEOUT,
      apiMode: record.apiMode === 'responses' ? 'responses' : 'images',
      codexCli: Boolean(record.codexCli),
      apiProxy: typeof record.apiProxy === 'boolean' ? record.apiProxy : DEFAULT_OPENAI_API_PROXY,
      responseFormatB64Json: record.responseFormatB64Json === true ? true : undefined,
    })
    profiles = [apiProfileToClientProfile(seed)]
    activeProfileId = seed.id
  }

  if (!profiles.some((p) => p.id === activeProfileId)) {
    activeProfileId = profiles[0].id
  }

  return {
    customProviders,
    providerOrder: Array.isArray(record.providerOrder) ? record.providerOrder.map(String) : undefined,
    clearInputAfterSubmit: typeof record.clearInputAfterSubmit === 'boolean' ? record.clearInputAfterSubmit : false,
    persistInputOnRestart: typeof record.persistInputOnRestart === 'boolean' ? record.persistInputOnRestart : true,
    reuseTaskApiProfileTemporarily: typeof record.reuseTaskApiProfileTemporarily === 'boolean' ? record.reuseTaskApiProfileTemporarily : false,
    alwaysShowRetryButton: typeof record.alwaysShowRetryButton === 'boolean' ? record.alwaysShowRetryButton : false,
    enterSubmit: typeof record.enterSubmit === 'boolean' ? record.enterSubmit : false,
    profiles,
    activeProfileId,
  }
}

// ===== Lookup helpers =====

export function getCustomProviderDefinition(settings: Partial<AppSettings> | unknown, provider: ApiProvider): CustomProviderDefinition | null {
  const normalized = normalizeSettings(settings)
  return normalized.customProviders.find((item) => item.id === provider) ?? null
}

export function getApiProviderLabel(settings: Partial<AppSettings> | unknown, provider: ApiProvider): string {
  if (provider === 'openai') return 'OpenAI'
  if (provider === 'gemini') return 'Gemini'
  return getCustomProviderDefinition(settings, provider)?.name ?? provider
}

export function isOpenAICompatibleProvider(settings: Partial<AppSettings> | unknown, provider: ApiProvider): boolean {
  return provider === 'openai' || Boolean(getCustomProviderDefinition(settings, provider))
}

export interface ImportedProviderSettings {
  customProviders: CustomProviderDefinition[]
  profiles: ApiProfile[]
}

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/)
  return match ? match[1].trim() : trimmed
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
    const customProviderIds = new Set(customProviders.map((provider) => provider.id))
    const profiles = Array.isArray(record.profiles)
      ? record.profiles
        .map((item) => { validateImportedProfileRecord(item); return item })
        .map((item) => normalizeApiProfile(item, undefined, customProviderIds))
        .filter((profile) => customProviderIds.has(profile.provider))
      : []
    return { customProviders, profiles }
  }

  const usedIds = new Set(existingProviders.map((provider) => provider.id))
  const direct = normalizeCustomProviderDefinition(parsed, usedIds)
  if (direct) return { customProviders: [direct], profiles: [] }
  throw new Error('无法识别该 JSON。请粘贴自定义服务商配置。')
}

export function importCustomProviderDefinitionFromJson(jsonText: string, existingProviders: CustomProviderDefinition[] = []): CustomProviderDefinition {
  const result = importCustomProviderSettingsFromJson(jsonText, existingProviders)
  return result.customProviders[0]
}

// ===== Active profile (synthetic ApiProfile view) =====

export function getActiveApiProfile(settings: Partial<AppSettings> | unknown): ApiProfile {
  const normalized = normalizeSettings(settings)
  const clientProfile = normalized.profiles.find((p) => p.id === normalized.activeProfileId) ?? normalized.profiles[0]
  if (!clientProfile) return createDefaultOpenAIProfile()
  return clientProfileToApiProfile(clientProfile)
}

export function validateApiProfile(profile: ApiProfile): string | null {
  if (!profile.name.trim()) return '缺少名称'
  if (!profile.baseUrl.trim()) return '缺少 API URL'
  if (!profile.apiKey.trim()) return '缺少 API Key'
  if (!profile.model.trim()) return '缺少模型 ID'
  return null
}

// ===== Default-state detection (for "replace vs append" import logic) =====

function isDefaultOpenAIProfile(profile: ApiProfile): boolean {
  return profile.id === DEFAULT_OPENAI_PROFILE_ID &&
    profile.name === '默认' &&
    profile.provider === 'openai' &&
    profile.baseUrl === DEFAULT_BASE_URL &&
    profile.apiKey === '' &&
    profile.model === DEFAULT_IMAGES_MODEL &&
    profile.timeout === DEFAULT_API_TIMEOUT &&
    profile.apiMode === 'images' &&
    profile.codexCli === false &&
    profile.apiProxy === DEFAULT_OPENAI_API_PROXY
}

function hasOnlyDefaultProfiles(settings: AppSettings): boolean {
  if (settings.customProviders.length !== 0) return false
  if (settings.profiles.length !== 1) return false
  const only = settings.profiles[0]
  if (only.source !== 'user-byok') return false
  return isDefaultOpenAIProfile(clientProfileToApiProfile(only))
}

function createImportedProfileId(provider: ApiProvider, usedIds: Set<string>): string {
  let id = `${provider}-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  while (usedIds.has(id)) {
    id = `${provider}-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }
  usedIds.add(id)
  return id
}

function getApiProfileDedupKey(profile: ApiProfile): string {
  return JSON.stringify([
    profile.provider,
    profile.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
    profile.apiKey.trim(),
    profile.model.trim(),
    profile.apiMode,
  ])
}

function getApiProfileConnectionKey(profile: ApiProfile): string {
  return JSON.stringify([
    profile.provider,
    profile.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
    profile.model.trim(),
    profile.apiMode,
  ])
}

function hasEquivalentApiProfile(existingProfiles: ApiProfile[], importedProfile: ApiProfile): boolean {
  const dedupKey = getApiProfileDedupKey(importedProfile)
  if (existingProfiles.some((profile) => getApiProfileDedupKey(profile) === dedupKey)) return true
  if (importedProfile.apiKey.trim()) return false
  const connectionKey = getApiProfileConnectionKey(importedProfile)
  return existingProfiles.some((profile) => getApiProfileConnectionKey(profile) === connectionKey)
}

function dedupeApiProfiles(profiles: ApiProfile[]): ApiProfile[] {
  const seen = new Set<string>()
  return profiles.filter((profile) => {
    const key = getApiProfileDedupKey(profile)
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

function mergeImportedCustomProviders(currentProviders: CustomProviderDefinition[], importedProviders: CustomProviderDefinition[]) {
  const providers = [...currentProviders]
  const providerIdMap = new Map<string, string>()
  const usedIds = new Set(providers.map((provider) => provider.id))
  const existingKeys = new Map(providers.map((provider) => [getCustomProviderDedupKey(provider), provider.id] as const))

  for (const provider of importedProviders) {
    const existingId = existingKeys.get(getCustomProviderDedupKey(provider))
    if (existingId) {
      providerIdMap.set(provider.id, existingId)
      continue
    }
    const normalized = normalizeCustomProviderDefinition(provider, usedIds)
    if (!normalized) continue
    providerIdMap.set(provider.id, normalized.id)
    providers.push(normalized)
    existingKeys.set(getCustomProviderDedupKey(normalized), normalized.id)
  }

  return { providers, providerIdMap }
}

export function findEquivalentApiProfile(
  settings: Partial<AppSettings> | unknown,
  importedProfile: ApiProfile,
  importedProviders: CustomProviderDefinition[] = [],
): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  const importedProvider = importedProviders.find((provider) => provider.id === importedProfile.provider)
  const provider = importedProvider
    ? normalized.customProviders.find((p) => getCustomProviderDedupKey(p) === getCustomProviderDedupKey(importedProvider))?.id ?? importedProfile.provider
    : importedProfile.provider
  const profile = { ...importedProfile, provider }
  const dedupKey = getApiProfileDedupKey(profile)
  const exactApi = normalized.profiles
    .map((p) => clientProfileToApiProfile(p))
    .find((item) => getApiProfileDedupKey(item) === dedupKey)
  if (exactApi) return exactApi
  if (profile.apiKey.trim()) return null
  const connectionKey = getApiProfileConnectionKey(profile)
  return normalized.profiles
    .map((p) => clientProfileToApiProfile(p))
    .find((item) => getApiProfileConnectionKey(item) === connectionKey) ?? null
}

export function mergeImportedSettings(currentSettings: Partial<AppSettings> | unknown, importedSettings: Partial<AppSettings> | unknown): AppSettings {
  const current = normalizeSettings(currentSettings)
  const normalizedImported = normalizeSettings(importedSettings)

  // Convert client profiles to ApiProfile shape for dedup logic, then back at storage boundary.
  const currentApi = current.profiles.map((p) => clientProfileToApiProfile(p))
  const importedApiRaw = normalizedImported.profiles.map((p) => clientProfileToApiProfile(p))
  const importedApi = dedupeApiProfiles(importedApiRaw)

  if (hasOnlyDefaultProfiles(current)) {
    return normalizeSettings({
      ...normalizedImported,
      profiles: importedApi.map(apiProfileToClientProfile),
    })
  }

  const usedIds = new Set(currentApi.map((profile) => profile.id))
  const existingKeys = new Set(currentApi.map(getApiProfileDedupKey))
  const { providers: customProviders, providerIdMap } = mergeImportedCustomProviders(current.customProviders, normalizedImported.customProviders)
  const importedFiltered = importedApi
    .map((profile) => providerIdMap.has(profile.provider)
      ? { ...profile, provider: providerIdMap.get(profile.provider) ?? profile.provider }
      : profile,
    )
    .filter((profile) => !existingKeys.has(getApiProfileDedupKey(profile)) && !hasEquivalentApiProfile(currentApi, profile))
    .map((profile) => ({ ...profile, id: createImportedProfileId(profile.provider, usedIds) }))
  const mergedApi = [...currentApi, ...importedFiltered]

  return normalizeSettings({
    ...current,
    customProviders,
    profiles: mergedApi.map(apiProfileToClientProfile),
    activeProfileId: current.activeProfileId,
  })
}

export const DEFAULT_SETTINGS: AppSettings = normalizeSettings({
  customProviders: [],
  profiles: [],
  clearInputAfterSubmit: false,
  persistInputOnRestart: true,
  reuseTaskApiProfileTemporarily: false,
  alwaysShowRetryButton: false,
  enterSubmit: false,
})

// ===== Back-compat shims (deprecated; will be removed once UI migrates to ClientProfile) =====

/** @deprecated builtin profile 现在是 `source: 'builtin-edge'`；用 `profile.source === 'builtin-edge'` 判断。 */
export const BUILTIN_PROFILE_ID_PREFIX = 'qlj-'

/** @deprecated 用 `profile.source === 'builtin-edge'` 判断。 */
export function isBuiltinProfile(profile: { id?: string; source?: string } | null | undefined): boolean {
  if (!profile) return false
  if (profile.source === 'builtin-edge') return true
  return typeof profile.id === 'string' && profile.id.startsWith(BUILTIN_PROFILE_ID_PREFIX)
}

// Re-export ClientProfile for downstream consumers that want both.
export type { ClientProfile } from './channels/types'
export { getPublicChannel }
