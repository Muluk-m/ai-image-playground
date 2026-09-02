/**
 * Channels 加载与发现。
 *
 * BFF 启动时调 `initChannels(filePath)` 一次读 channels.json：
 *   - 文件不存在 → 空列表 + warning
 *   - JSON 损坏 / schema 不匹配 → 抛 ChannelsLoadError，由 startup 拦截决定退出还是降级
 *   - secretRef 指向的 env 不存在 → 该 channel 进 warnings，但仍保留在列表里
 *     （sanitize 输出给前端，调用上游时再失败，比启动期 fail-fast 更宽容）
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
  ChannelModel,
  DiscoveredChannel,
} from '@image-playground/shared'
import { CHANNEL_CAPABILITIES } from '@image-playground/shared'
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

export interface ChannelsLoadResult {
  channels: InternalChannel[]
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

function parseModels(v: unknown, channelCtx: string): ChannelModel[] {
  if (!Array.isArray(v) || v.length === 0)
    throw new ChannelsLoadError(`${channelCtx}: models must be a non-empty array`)
  return v.map((raw, idx) => {
    const ctx = `${channelCtx}.models[${idx}]`
    if (!isObject(raw)) throw new ChannelsLoadError(`${ctx} must be an object`)
    return {
      id: requireNonEmptyString(raw.id, `${ctx}.id`),
      label: requireNonEmptyString(raw.label, `${ctx}.label`),
      capabilities: parseCapabilities(raw.capabilities, ctx),
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
    if (typeof v.timeout !== 'number' || !Number.isFinite(v.timeout))
      throw new ChannelsLoadError(`${ctx}.defaults.timeout must be number`)
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

function parseChannel(raw: unknown, idx: number): InternalChannel {
  const ctx = `channels[${idx}]`
  if (!isObject(raw)) throw new ChannelsLoadError(`${ctx} must be an object`)

  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id))
    throw new ChannelsLoadError(`${ctx}.id must be kebab-case ([a-z0-9-]+)`)
  if (typeof raw.kind !== 'string' || !VALID_KINDS.includes(raw.kind as ChannelKind))
    throw new ChannelsLoadError(
      `${ctx}.kind must be one of: ${VALID_KINDS.join(', ')} (got '${String(raw.kind)}')`,
    )
  if (typeof raw.baseUrl !== 'string' || !/^https?:\/\//.test(raw.baseUrl))
    throw new ChannelsLoadError(`${ctx}.baseUrl must start with http:// or https://`)
  if (!isStringArray(raw.allowedPaths) || raw.allowedPaths.length === 0)
    throw new ChannelsLoadError(`${ctx}.allowedPaths must be a non-empty string[]`)

  return {
    id: raw.id,
    kind: raw.kind as ChannelKind,
    label: requireNonEmptyString(raw.label, `${ctx}.label`),
    baseUrl: raw.baseUrl.replace(/\/+$/, ''),
    auth: parseAuth(raw.auth, ctx),
    allowedPaths: raw.allowedPaths,
    models: parseModels(raw.models, ctx),
    defaults: parseDefaults(raw.defaults, ctx),
  }
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
  const channels: InternalChannel[] = channelsRaw.map((raw, idx) => {
    const ch = parseChannel(raw, idx)
    if (seenIds.has(ch.id)) throw new ChannelsLoadError(`channels[${idx}].id duplicate: '${ch.id}'`)
    seenIds.add(ch.id)

    const secret = envLookup(ch.auth.secretRef)?.trim() ?? ''
    if (!secret) {
      warnings.push(
        `channel '${ch.id}': env '${ch.auth.secretRef}' is empty or unset; upstream calls will fail until it's provided`,
      )
    }
    return { ...ch, auth: { ...ch.auth, secret } }
  })
  return { channels, warnings }
}

/** 默认 channels.json 解析位置：apps/bff/channels.json（相对于本文件）。 */
export function defaultChannelsPath(): string {
  return join(import.meta.dir, '../../channels.json')
}

/**
 * 顶层入口：读文件 + 解析 + 解析 secret。
 *
 * 文件不存在不抛错（返回空 channels + warning），让 BFF 在没配 channels 时
 * 也能 serve BYOK 路径。其它 IO / parse / schema 错抛 ChannelsLoadError。
 */
export function loadChannelsFromFile(filePath: string): ChannelsLoadResult {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return {
        channels: [],
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
let discoveredCache: DiscoveredChannel[] = []

export function initChannels(filePath = defaultChannelsPath()): ChannelsLoadResult {
  const result = loadChannelsFromFile(filePath)
  setLoaded(result.channels)
  return result
}

export function getChannels(): InternalChannel[] {
  return loaded
}

export function getDiscoveredChannels(): DiscoveredChannel[] {
  return discoveredCache
}

function setLoaded(channels: InternalChannel[]): void {
  loaded = channels
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
export function _setChannelsForTesting(channels: InternalChannel[]): void {
  setLoaded(channels)
}
