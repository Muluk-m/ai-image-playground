/**
 * Channels 加载与发现。
 *
 * BFF 启动时调 `initChannels(filePath)` 一次读 channels.json：
 *   - 文件不存在 → 空列表 + warning
 *   - JSON 损坏 / schema 不匹配 → 抛 ChannelsLoadError，由 startup 拦截决定退出还是降级
 *   - secretRef 指向的 env 不存在 → 该 channel 进 warnings，但仍保留在列表里
 *     （sanitize 输出给前端，调用上游时再失败，比启动期 fail-fast 更宽容）；
 *     声明了 `requiresSecret` 的 channel 例外，缺 secret 时整条丢弃
 *   - baseUrlRef 指向的 env 不存在 / 不是合法 https URL → 该 channel 进 warnings 并被整条丢弃。
 *     跟缺 secret 不同：没有上游地址就没有「调用上游时再失败」这一步，留着只会拼出非法 URL。
 *   - `disabled: true` → 运营暂时下线整条 channel：照常校验 schema，但不广播、不进 `getChannels()`，
 *     智能体与服务端选模型都看不到它，新任务提交被拒（`isModelDisabled`）；只有下线前已提交的
 *     任务还能经 `getRoutableChannels()` 在原上游续轮询。密钥与 env 原样留着，删掉这一行
 *     （或改成 false）发版即恢复。
 *
 * `getChannels()` 返回内部全字段（含 baseUrl / auth / 已解析 secret），仅 BFF 内部使用。
 * `getDiscoveredChannels()` 返回 sanitized 字段，可安全经 /api/channels 发给前端。
 *
 * ⚠️ channels.json 的数组顺序是产品契约：前端按序注入 builtin profile，
 * **channels[0] 会成为新访客的默认模型**（apps/web apiProfiles.ts 的
 * injectBuiltinEdgeProfiles + activeProfileId 兜底取 profiles[0]）。
 * 新增 channel 往后排，别随手插第一位。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChannelCapability,
  ChannelDefaults,
  ChannelKind,
  ChannelMedia,
  ChannelModel,
  DiscoveredChannel,
  ModelBadge,
  QueueProvider,
} from '@image-playground/shared'
import { CHANNEL_CAPABILITIES, MODEL_BADGES } from '@image-playground/shared'
import { isObject } from './type-guards'

export type ChannelAuthType = 'bearer' | 'query-key'

export interface ChannelAuth {
  type: ChannelAuthType
  /** 环境变量名（schema 字段，文件里写的）。 */
  secretRef: string
  /** auth.type='query-key' 时附带（如 Gemini 的 ?key=...）。 */
  queryParam?: string
  /** 启动时从 process.env[secretRef] 取出来的真实值；缺失为空字符串。 */
  secret: string
}

export interface InternalChannel {
  id: string
  kind: ChannelKind
  label: string
  baseUrl: string
  auth: ChannelAuth
  allowedPaths: string[]
  models: ChannelModel[]
  defaults: ChannelDefaults
}

/** parseChannel 的产物：baseUrl 尚未解析，只有 `baseUrl` / `baseUrlRef` 二选一。 */
interface ParsedChannel extends Omit<InternalChannel, 'baseUrl'> {
  baseUrl?: string
  baseUrlRef?: string
  requiresSecret: boolean
  disabled: boolean
}

export interface ChannelsLoadResult {
  channels: InternalChannel[]
  /**
   * `disabled: true` 且上游地址与 secret 都齐的 channel。不广播、不进 `getChannels()`，
   * 只留给 `getRoutableChannels()`：下线前已经提交的任务还要在原上游续轮询。
   */
  disabled: InternalChannel[]
  /** 所有 `disabled: true` channel 声明的模型（id → channel id），不管 env 齐不齐；新任务据此拒收。 */
  disabledModels: Record<string, string>
  /** 非致命问题清单（缺 secret 等），由 startup 落日志。 */
  warnings: string[]
}

export class ChannelsLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelsLoadError'
  }
}

const VALID_KINDS: readonly ChannelKind[] = ['openai-queue', 'gemini-queue']
const VALID_AUTH_TYPES: readonly ChannelAuthType[] = ['bearer', 'query-key']
// 直接复用 shared 的 tuple，不再本地重列 — 手抄一份的后果见 CHANNEL_CAPABILITIES 上的注释：
// 类型注解只约束成员合法，不保证列全，两边悄悄漂移后新 token 会在启动校验时炸掉整个 BFF。
const VALID_CAPABILITIES: readonly ChannelCapability[] = CHANNEL_CAPABILITIES
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function requireNonEmptyString(v: unknown, ctx: string): string {
  if (typeof v !== 'string' || v.length === 0)
    throw new ChannelsLoadError(`${ctx} must be non-empty string`)
  return v
}

function parseCapabilities(v: unknown, ctx: string): ChannelCapability[] {
  if (!Array.isArray(v)) throw new ChannelsLoadError(`${ctx}: capabilities must be an array`)
  return v.map((cap) => {
    if (typeof cap !== 'string' || !VALID_CAPABILITIES.includes(cap as ChannelCapability))
      throw new ChannelsLoadError(
        `${ctx}: invalid capability '${String(cap)}' (allowed: ${VALID_CAPABILITIES.join(', ')})`,
      )
    return cap as ChannelCapability
  })
}

const VALID_MEDIA: readonly ChannelMedia[] = ['image', 'video']

function parseMedia(v: unknown, ctx: string): ChannelMedia | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !VALID_MEDIA.includes(v as ChannelMedia))
    throw new ChannelsLoadError(`${ctx}.media must be one of: ${VALID_MEDIA.join(', ')}`)
  return v as ChannelMedia
}

/** 选择器标签：只认 shared 里登记过的 token，重复的视为配置错误。 */
function parseBadges(v: unknown, ctx: string): ModelBadge[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new ChannelsLoadError(`${ctx}.badges must be an array`)
  const seen = new Set<string>()
  return v.map((badge) => {
    if (typeof badge !== 'string' || !MODEL_BADGES.includes(badge as ModelBadge))
      throw new ChannelsLoadError(
        `${ctx}: invalid badge '${String(badge)}' (allowed: ${MODEL_BADGES.join(', ')})`,
      )
    if (seen.has(badge)) throw new ChannelsLoadError(`${ctx}: duplicate badge '${badge}'`)
    seen.add(badge)
    return badge as ModelBadge
  })
}

function parseEtaSeconds(v: unknown, ctx: string): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > 3600)
    throw new ChannelsLoadError(`${ctx}.etaSeconds must be an integer between 1 and 3600`)
  return v
}

function parseModels(v: unknown, channelCtx: string): ChannelModel[] {
  if (!Array.isArray(v) || v.length === 0)
    throw new ChannelsLoadError(`${channelCtx}: models must be a non-empty array`)
  return v.map((raw, idx) => {
    const ctx = `${channelCtx}.models[${idx}]`
    if (!isObject(raw)) throw new ChannelsLoadError(`${ctx} must be an object`)
    const media = parseMedia(raw.media, ctx)
    const badges = parseBadges(raw.badges, ctx)
    const etaSeconds = parseEtaSeconds(raw.etaSeconds, ctx)
    return {
      id: requireNonEmptyString(raw.id, `${ctx}.id`),
      label: requireNonEmptyString(raw.label, `${ctx}.label`),
      capabilities: parseCapabilities(raw.capabilities, ctx),
      ...(media ? { media } : {}),
      ...(badges ? { badges } : {}),
      ...(etaSeconds !== undefined ? { etaSeconds } : {}),
    }
  })
}

function parseDefaults(v: unknown, ctx: string): ChannelDefaults {
  if (v === undefined) return {}
  if (!isObject(v)) throw new ChannelsLoadError(`${ctx}.defaults must be an object`)
  const out: ChannelDefaults = {}
  if (v.apiMode !== undefined) {
    if (v.apiMode !== 'images' && v.apiMode !== 'responses')
      throw new ChannelsLoadError(`${ctx}.defaults.apiMode must be 'images' or 'responses'`)
    out.apiMode = v.apiMode
  }
  if (v.codexCli !== undefined) {
    if (typeof v.codexCli !== 'boolean')
      throw new ChannelsLoadError(`${ctx}.defaults.codexCli must be boolean`)
    out.codexCli = v.codexCli
  }
  if (v.timeout !== undefined) {
    // <= 0 会让前端 `setTimeout(abort, 0)` 在请求发出的同一 tick 掐断它，
    // 用户只看到一句 "The user aborted a request."——配置期就挡住。
    if (typeof v.timeout !== 'number' || !Number.isFinite(v.timeout) || v.timeout <= 0)
      throw new ChannelsLoadError(`${ctx}.defaults.timeout must be a positive number`)
    out.timeout = v.timeout
  }
  if (v.responseFormatB64Json !== undefined) {
    if (typeof v.responseFormatB64Json !== 'boolean')
      throw new ChannelsLoadError(`${ctx}.defaults.responseFormatB64Json must be boolean`)
    out.responseFormatB64Json = v.responseFormatB64Json
  }
  if (v.asyncTasks !== undefined) {
    if (typeof v.asyncTasks !== 'boolean')
      throw new ChannelsLoadError(`${ctx}.defaults.asyncTasks must be boolean`)
    out.asyncTasks = v.asyncTasks
  }
  return out
}

/**
 * 强制 UPPER_SNAKE_CASE 是双重防御：既符合 env 变量命名惯例，又顺便拦下
 * 误写成真 key 的情况（`sk-...` / `AIza...` / 含 `-` 的随机串都通不过）。
 */
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/

function parseAuth(v: unknown, ctx: string): ChannelAuth {
  if (!isObject(v)) throw new ChannelsLoadError(`${ctx}.auth must be an object`)
  if (typeof v.type !== 'string' || !VALID_AUTH_TYPES.includes(v.type as ChannelAuthType))
    throw new ChannelsLoadError(`${ctx}.auth.type must be one of: ${VALID_AUTH_TYPES.join(', ')}`)
  const secretRef = requireNonEmptyString(v.secretRef, `${ctx}.auth.secretRef`)
  if (!ENV_NAME_PATTERN.test(secretRef))
    throw new ChannelsLoadError(
      `${ctx}.auth.secretRef must be an UPPER_SNAKE_CASE env var name (got '${secretRef}')`,
    )
  const out: ChannelAuth = {
    type: v.type as ChannelAuthType,
    secretRef,
    secret: '',
  }
  if (v.type === 'query-key') {
    out.queryParam = requireNonEmptyString(
      v.queryParam,
      `${ctx}.auth.queryParam (required when type='query-key')`,
    )
  }
  return out
}

const HTTP_URL_PATTERN = /^https?:\/\//

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/** `baseUrl` 字面值与 `baseUrlRef` env 名二选一，不允许同时出现。 */
function parseBaseUrlSource(raw: Record<string, unknown>, ctx: string): Partial<ParsedChannel> {
  if (raw.baseUrl !== undefined && raw.baseUrlRef !== undefined)
    throw new ChannelsLoadError(`${ctx} must set exactly one of baseUrl or baseUrlRef`)
  if (raw.baseUrlRef !== undefined) {
    const ref = requireNonEmptyString(raw.baseUrlRef, `${ctx}.baseUrlRef`)
    if (!ENV_NAME_PATTERN.test(ref))
      throw new ChannelsLoadError(
        `${ctx}.baseUrlRef must be an UPPER_SNAKE_CASE env var name (got '${ref}')`,
      )
    return { baseUrlRef: ref }
  }
  if (typeof raw.baseUrl !== 'string' || !HTTP_URL_PATTERN.test(raw.baseUrl))
    throw new ChannelsLoadError(`${ctx}.baseUrl must start with http:// or https://`)
  return { baseUrl: normalizeBaseUrl(raw.baseUrl) }
}

function parseOptionalFlag(v: unknown, ctx: string): boolean {
  if (v !== undefined && typeof v !== 'boolean')
    throw new ChannelsLoadError(`${ctx} must be boolean`)
  return v === true
}

function parseChannel(raw: unknown, idx: number): ParsedChannel {
  const ctx = `channels[${idx}]`
  if (!isObject(raw)) throw new ChannelsLoadError(`${ctx} must be an object`)

  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id))
    throw new ChannelsLoadError(`${ctx}.id must be kebab-case ([a-z0-9-]+)`)
  if (typeof raw.kind !== 'string' || !VALID_KINDS.includes(raw.kind as ChannelKind))
    throw new ChannelsLoadError(
      `${ctx}.kind must be one of: ${VALID_KINDS.join(', ')} (got '${String(raw.kind)}')`,
    )
  if (!isStringArray(raw.allowedPaths) || raw.allowedPaths.length === 0)
    throw new ChannelsLoadError(`${ctx}.allowedPaths must be a non-empty string[]`)

  return {
    id: raw.id,
    kind: raw.kind as ChannelKind,
    label: requireNonEmptyString(raw.label, `${ctx}.label`),
    ...parseBaseUrlSource(raw, ctx),
    requiresSecret: parseOptionalFlag(raw.requiresSecret, `${ctx}.requiresSecret`),
    disabled: parseOptionalFlag(raw.disabled, `${ctx}.disabled`),
    auth: parseAuth(raw.auth, ctx),
    allowedPaths: raw.allowedPaths,
    models: parseModels(raw.models, ctx),
    defaults: parseDefaults(raw.defaults, ctx),
  }
}

/** `new URL` 把 IPv6 主机名还原成带方括号的形式，所以这里也带。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * 解析成功返回 baseUrl；env 缺失或值非法返回 warning 文案，由调用方丢弃该 channel。
 *
 * 只认 https —— channel 的 API key 是随请求发出去的，明文 http 会把它送上网络。
 * 回环地址例外，本机 dev 反代没法给自己签证书。
 */
function resolveBaseUrl(
  ch: ParsedChannel,
  envLookup: (key: string) => string | undefined,
): { baseUrl: string } | { warning: string } {
  if (ch.baseUrl !== undefined) return { baseUrl: ch.baseUrl }
  const ref = ch.baseUrlRef as string
  const value = envLookup(ref)?.trim() ?? ''
  const disabled = (reason: string): { warning: string } => ({
    warning: `channel '${ch.id}': env '${ref}' ${reason}; the channel is disabled and will not be advertised`,
  })

  if (!value) return disabled('is empty or unset')

  // 前缀正则挡不住 'https://' 与 'https://?x'：它们过得了正则，却没有主机名。
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return disabled('is not a valid absolute https:// URL')
  }
  if (!parsed.hostname) return disabled('is not a valid absolute https:// URL')

  const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)
  if (parsed.protocol !== 'https:' && !loopbackHttp)
    return disabled('must use https:// (http:// is accepted only for loopback hosts)')

  return { baseUrl: normalizeBaseUrl(value) }
}

/**
 * 从 JSON 文本（已 parse 的 unknown）解析出 channels 列表 + 解析 secret。
 *
 * 暴露这个低层 API 是为了让测试不依赖文件系统。
 */
export function parseChannelsConfig(
  input: unknown,
  envLookup: (key: string) => string | undefined,
): ChannelsLoadResult {
  if (!isObject(input)) throw new ChannelsLoadError('root must be an object')
  const channelsRaw = input.channels
  if (!Array.isArray(channelsRaw)) throw new ChannelsLoadError('channels must be an array')

  const warnings: string[] = []
  const seenIds = new Set<string>()
  const channels: InternalChannel[] = []
  const disabled: InternalChannel[] = []
  // 无原型：模型 id 只校验非空，`constructor` 之类的键不能撞上继承属性。
  const disabledModels: Record<string, string> = Object.create(null)
  channelsRaw.forEach((raw, idx) => {
    const ch = parseChannel(raw, idx)
    if (seenIds.has(ch.id)) throw new ChannelsLoadError(`channels[${idx}].id duplicate: '${ch.id}'`)
    seenIds.add(ch.id)

    const resolved = resolveBaseUrl(ch, envLookup)
    if (ch.disabled) {
      // 下线的 channel 合成一条 warning：新任务反正不收，env 缺失只影响下线前已提交的任务，
      // 这一点要说清楚——那些任务会在路由时明确失败，而不是落进通用网关。
      for (const model of ch.models)
        if (!Object.hasOwn(disabledModels, model.id)) disabledModels[model.id] = ch.id
      const secret = envLookup(ch.auth.secretRef)?.trim() ?? ''
      const base = `channel '${ch.id}': disabled in channels.json; the channel will not be advertised or offered for new tasks`
      if ('baseUrl' in resolved && secret) {
        disabled.push(toInternal(ch, resolved.baseUrl, secret))
        warnings.push(base)
      } else {
        const missing =
          'warning' in resolved ? resolved.warning : `env '${ch.auth.secretRef}' is empty or unset`
        warnings.push(
          `${base}; tasks submitted before it was disabled cannot be routed and will fail (${missing})`,
        )
      }
      return
    }
    if ('warning' in resolved) {
      warnings.push(resolved.warning)
      return
    }

    const secret = envLookup(ch.auth.secretRef)?.trim() ?? ''
    if (!secret) {
      // 直连上游没有 key 就只是个必然失败的模型，宁可整条不广播；缺省的宽容留给网关部署。
      if (ch.requiresSecret) {
        warnings.push(
          `channel '${ch.id}': env '${ch.auth.secretRef}' is empty or unset; the channel is disabled and will not be advertised`,
        )
        return
      }
      warnings.push(
        `channel '${ch.id}': env '${ch.auth.secretRef}' is empty or unset; upstream calls will fail until it's provided`,
      )
    }
    channels.push(toInternal(ch, resolved.baseUrl, secret))
  })
  return { channels, disabled, disabledModels, warnings }
}

function toInternal(ch: ParsedChannel, baseUrl: string, secret: string): InternalChannel {
  const { baseUrlRef: _ref, requiresSecret: _requiresSecret, disabled: _disabled, ...rest } = ch
  return { ...rest, baseUrl, auth: { ...ch.auth, secret } }
}

/** 默认 channels.json 解析位置：apps/bff/channels.json（相对于本文件）。 */
export function defaultChannelsPath(): string {
  return join(import.meta.dir, '../../channels.json')
}

/**
 * 顶层入口：读文件 + 解析 + 解析 secret。
 *
 * 文件不存在不抛错（返回空 channels + warning），让 BFF 在没配 channels 时
 * 仍能起来。其它 IO / parse / schema 错抛 ChannelsLoadError。
 */
export function loadChannelsFromFile(filePath: string): ChannelsLoadResult {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return {
        channels: [],
        disabled: [],
        disabledModels: {},
        warnings: [`channels file not found: ${filePath} (BFF will serve no built-in channels)`],
      }
    }
    throw new ChannelsLoadError(`failed to read ${filePath}: ${(err as Error).message}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new ChannelsLoadError(`failed to parse ${filePath}: ${(err as Error).message}`)
  }
  return parseChannelsConfig(json, (k) => process.env[k])
}

function isFileNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}

/* ────────────────────────── 模块级状态 ────────────────────────── */

let loaded: InternalChannel[] = []
let retired: InternalChannel[] = []
let disabledModels: ReadonlyMap<string, string> = new Map()
let discoveredCache: DiscoveredChannel[] = []

export function initChannels(filePath = defaultChannelsPath()): ChannelsLoadResult {
  const result = loadChannelsFromFile(filePath)
  setLoaded(result.channels, result.disabled, result.disabledModels)
  return result
}

export function getChannels(): InternalChannel[] {
  return loaded
}

/**
 * 上游路由专用：在用的 channel 在前，下线（`disabled`）的在后。下线前已提交的任务靠它
 * 回到原上游续轮询，而不是落进通用网关拼出一条错的请求。选模型、广播一律用 `getChannels()`。
 */
export function getRoutableChannels(): InternalChannel[] {
  return retired.length ? [...loaded, ...retired] : loaded
}

/** 只在下线 channel 里声明的模型：新任务一律不收，别让它经通用网关兜底跑出去。 */
export function isModelDisabled(model: string): boolean {
  return disabledModels.has(model)
}

/** 下线模型所属 channel 的 id；没下线（或还挂在在用 channel 上）时 undefined。 */
export function disabledModelChannel(model: string): string | undefined {
  return disabledModels.get(model)
}

export function getDiscoveredChannels(): DiscoveredChannel[] {
  return discoveredCache
}

/** 模型声明的媒介类型；模型没在任何 channel 里声明时 undefined。缺省视为 image。 */
export function resolveModelMedia(model: string): ChannelMedia | undefined {
  for (const channel of loaded) {
    const declared = channel.models.find((m) => m.id === model)
    if (declared) return declared.media ?? 'image'
  }
  return undefined
}

/**
 * 这个模型在 channels.json 里声明的能力清单；模型不在任何 channel 里时 undefined。
 *
 * 与前端 `getParamCapabilities` 同一套口径：没声明过的模型按「什么都支持」处理，
 * 清单里缺哪一项才是明确的「这个模型没有」。智能体据此补上创作页在分发层做的 prompt 变换。
 */
export function modelCapabilities(model: string): readonly ChannelCapability[] | undefined {
  for (const channel of loaded) {
    const declared = channel.models.find((m) => m.id === model)
    if (declared) return declared.capabilities
  }
  return undefined
}

/** 给了 id 就按 id 找，没给就取该介质的默认模型——channels 数组顺序是产品契约。 */
export function resolveQueueModel(
  media: ChannelMedia,
  modelId?: string,
): { provider: QueueProvider; model: string } | undefined {
  for (const channel of loaded) {
    for (const model of channel.models) {
      if ((model.media ?? 'image') !== media) continue
      if (modelId && model.id !== modelId) continue
      return { provider: queueProviderOf(channel.kind), model: model.id }
    }
  }
  return undefined
}

function queueProviderOf(kind: ChannelKind): QueueProvider {
  return kind === 'gemini-queue' ? 'gemini' : 'openai-compat'
}

function setLoaded(
  channels: InternalChannel[],
  disabled: InternalChannel[] = [],
  disabledIds: Readonly<Record<string, string>> = Object.fromEntries(
    disabled.flatMap((c) => c.models.map((m) => [m.id, c.id])),
  ),
): void {
  loaded = channels
  retired = disabled
  // 同一个模型还挂在某条在用的 channel 上，就照常收。
  const active = new Set(channels.flatMap((channel) => channel.models.map((model) => model.id)))
  disabledModels = new Map(Object.entries(disabledIds).filter(([id]) => !active.has(id)))
  discoveredCache = channels.map(sanitizeChannel)
}

function sanitizeChannel(c: InternalChannel): DiscoveredChannel {
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    models: c.models,
    defaults: c.defaults,
  }
}

/** 仅供测试：直接塞入解析好的 channels，绕过文件系统。 */
export function _setChannelsForTesting(
  channels: InternalChannel[],
  disabled: InternalChannel[] = [],
  disabledModels?: Readonly<Record<string, string>>,
): void {
  setLoaded(channels, disabled, disabledModels)
}
