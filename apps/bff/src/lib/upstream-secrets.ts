import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { log } from './logger'
import {
  replaceUpstreamSecretCache,
  resetUpstreamSecretCacheForTests,
} from './upstream-secret-cache'

export { runtimeSecret } from './upstream-secret-cache'

/** How often each BFF and worker process re-reads admin overrides. In-flight calls keep the key they already resolved. */
export const UPSTREAM_SECRET_REFRESH_MS = 10_000

const MASTER_KEY_ENV = 'UPSTREAM_SECRETS_MASTER_KEY'

export const UPSTREAM_SECRET_SLOTS = [
  { id: 'openai_direct', label: 'OpenAI 直连', env: 'OPENAI_API_KEY' },
  { id: 'gemini', label: 'Gemini', env: 'GEMINI_API_KEY' },
  { id: 'vertex', label: 'Vertex', env: 'VERTEX_API_KEY' },
  { id: 'sub2api', label: 'sub2api', env: 'UPSTREAM_API_KEY' },
] as const

export type UpstreamSecretSlotId = (typeof UPSTREAM_SECRET_SLOTS)[number]['id']
export type UpstreamSecretSource = 'admin' | 'env' | 'unset'

export interface UpstreamSecretView {
  readonly id: UpstreamSecretSlotId
  readonly label: string
  readonly configured: boolean
  readonly source: UpstreamSecretSource
  readonly updatedAt: number | null
  readonly updatedBy: string | null
}

export interface UpstreamSecretsView {
  readonly writable: boolean
  readonly disabledReason: string | null
  readonly warning: string | null
  readonly secrets: readonly UpstreamSecretView[]
}

export class UpstreamSecretError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'UpstreamSecretError'
  }
}

interface SlotMeta {
  updatedAt: number
  updatedBy: string
}

interface MasterKey {
  ok: true
  key: Buffer
}

interface MasterKeyProblem {
  ok: false
  code: 'master_key_missing' | 'master_key_invalid'
  reason: string
}

type SecretRow = typeof schema.upstream_api_secrets.$inferSelect

let appliedMeta = new Map<string, SlotMeta>()
let warning: string | null = null
let loggedProblem: string | null = null
let appliedRevision: string | undefined
let appliedMasterKey: Buffer | undefined

const MISSING_MASTER_KEY = `未配置 ${MASTER_KEY_ENV}，不能写入或替换。生成继续使用环境变量里的密钥。`
const INVALID_MASTER_KEY = `${MASTER_KEY_ENV} 必须是 32 字节，用 base64 或 64 位十六进制。不能写入或替换。生成继续使用环境变量里的密钥。`
const DECRYPT_WARNING = '有后台密钥无法解密，这些密钥已回退到环境变量。请用当前主密钥重新保存。'

function slotById(id: string) {
  return UPSTREAM_SECRET_SLOTS.find((slot) => slot.id === id)
}

function requireSlot(id: string) {
  const slot = slotById(id)
  if (!slot) throw new UpstreamSecretError('unknown_slot', 404, '未知密钥')
  return slot
}

/** 32-byte master key. Missing and malformed are different errors; neither value is returned. */
export function readMasterKey(env: NodeJS.ProcessEnv = process.env): MasterKey | MasterKeyProblem {
  const raw = env[MASTER_KEY_ENV]?.trim() ?? ''
  if (!raw) return { ok: false, code: 'master_key_missing', reason: MISSING_MASTER_KEY }
  if (/^[0-9a-f]{64}$/i.test(raw)) return { ok: true, key: Buffer.from(raw, 'hex') }
  const decoded = Buffer.from(raw, 'base64')
  const canonical = decoded.toString('base64').replace(/=+$/, '')
  if (decoded.length === 32 && canonical === raw.replace(/=+$/, '')) {
    return { ok: true, key: decoded }
  }
  return { ok: false, code: 'master_key_invalid', reason: INVALID_MASTER_KEY }
}

export function assertSecretMaterial(value: unknown): string {
  if (typeof value !== 'string') throw new UpstreamSecretError('invalid_secret', 400, '密钥无效')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 4096 || /[\u0000\r\n]/.test(trimmed)) {
    throw new UpstreamSecretError('invalid_secret', 400, '密钥无效')
  }
  return trimmed
}

function encrypt(key: Buffer, slotId: string, plaintext: string) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(slotId))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export interface SealedSecret {
  nonce: string
  tag: string
  ciphertext: string
}

/** 与上游密钥同一套 AES-256-GCM。`aad` 把密文绑到这一行，换行贴过去解不开。 */
export function sealSecret(aad: string, plaintext: string): SealedSecret {
  const master = readMasterKey()
  if (!master.ok) throw new UpstreamSecretError(master.code, 503, master.reason)
  return encrypt(master.key, aad, plaintext)
}

export function openSecret(aad: string, sealed: SealedSecret): string | null {
  const master = readMasterKey()
  if (!master.ok) return null
  return decrypt(master.key, aad, sealed)
}

function decrypt(key: Buffer, slotId: string, row: SealedSecret): string | null {
  try {
    const nonce = Buffer.from(row.nonce, 'base64')
    const tag = Buffer.from(row.tag, 'base64')
    const ciphertext = Buffer.from(row.ciphertext, 'base64')
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return null
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(slotId))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    )
    if (!plaintext || plaintext.length > 4096 || /[\u0000\r\n]/.test(plaintext)) return null
    return plaintext
  } catch {
    return null
  }
}

function noteProblem(problem: string | null) {
  if (problem === loggedProblem) return
  loggedProblem = problem
  if (problem) log.warn({ event: 'upstream_secrets.unavailable' }, problem)
}

function envFallback(envName: string): string {
  if (envName === 'OPENAI_API_KEY') return config.gptDirect.apiKey.trim()
  if (envName === 'UPSTREAM_API_KEY') return config.upstream.apiKey.trim()
  return process.env[envName]?.trim() ?? ''
}

function operatorIdOf(value: string | null | undefined): string {
  const trimmed = value?.trim() || 'admin'
  return trimmed.slice(0, 200)
}

function currentView(): UpstreamSecretsView {
  const master = readMasterKey()
  return {
    writable: master.ok,
    disabledReason: master.ok ? null : master.reason,
    warning,
    secrets: UPSTREAM_SECRET_SLOTS.map((slot) => {
      const admin = appliedMeta.get(slot.id)
      const fromEnv = envFallback(slot.env)
      const source: UpstreamSecretSource = admin ? 'admin' : fromEnv ? 'env' : 'unset'
      return {
        id: slot.id,
        label: slot.label,
        configured: admin !== undefined || fromEnv !== '',
        source,
        updatedAt: admin?.updatedAt ?? null,
        updatedBy: admin?.updatedBy ?? null,
      }
    }),
  }
}

/** Re-read overrides. Failures keep the previous cache so a database blip does not drop a live key. */
async function refreshUpstreamSecretsOnce(): Promise<void> {
  const master = readMasterKey()
  if (!master.ok) {
    appliedRevision = undefined
    appliedMasterKey = undefined
    replaceUpstreamSecretCache(new Map())
    appliedMeta = new Map()
    warning = null
    noteProblem(master.reason)
    return
  }
  try {
    const [version] = await db.execute<{ revision: string }>(sql`
      SELECT md5(COALESCE(jsonb_agg(to_jsonb(secrets) ORDER BY secrets.id)::text, '[]')) AS revision
      FROM ${schema.upstream_api_secrets} AS secrets
    `)
    if (version?.revision === appliedRevision && appliedMasterKey?.equals(master.key)) return
    const rows = await db.select().from(schema.upstream_api_secrets)
    const next = new Map<string, string>()
    const meta = new Map<string, SlotMeta>()
    let ignored = 0
    for (const row of rows) {
      const slot = slotById(row.id)
      if (!slot) continue
      const plaintext = decrypt(master.key, slot.id, row)
      if (plaintext === null) {
        ignored += 1
        continue
      }
      next.set(slot.env, plaintext)
      meta.set(slot.id, { updatedAt: row.updated_at, updatedBy: row.updated_by })
    }
    replaceUpstreamSecretCache(next)
    appliedMeta = meta
    warning = ignored > 0 ? DECRYPT_WARNING : null
    noteProblem(null)
    appliedRevision = version?.revision
    appliedMasterKey = master.key
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    log.warn(
      { event: 'upstream_secrets.refresh_failed', err: message },
      'upstream secret refresh failed',
    )
  }
}

let refreshChain: Promise<void> = Promise.resolve()

/** Serialized so a slow read that started before a save cannot overwrite the save. */
export function refreshUpstreamSecrets(): Promise<void> {
  const run = refreshChain.then(refreshUpstreamSecretsOnce, refreshUpstreamSecretsOnce)
  refreshChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function resetUpstreamSecretsForTests(): void {
  resetUpstreamSecretCacheForTests()
  appliedMeta = new Map()
  warning = null
  loggedProblem = null
  appliedRevision = undefined
  appliedMasterKey = undefined
}

export async function listUpstreamSecrets(): Promise<UpstreamSecretsView> {
  await refreshUpstreamSecrets()
  return currentView()
}

export async function replaceUpstreamSecret(input: {
  slotId: string
  apiKey: unknown
  operatorId: string | null
}): Promise<UpstreamSecretsView> {
  const slot = requireSlot(input.slotId)
  const apiKey = assertSecretMaterial(input.apiKey)
  const master = readMasterKey()
  if (!master.ok) throw new UpstreamSecretError(master.code, 503, master.reason)
  const sealed = encrypt(master.key, slot.id, apiKey)
  const updatedAt = Date.now()
  const operatorId = operatorIdOf(input.operatorId)
  const row = {
    id: slot.id,
    ...sealed,
    updated_at: updatedAt,
    updated_by: operatorId,
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.upstream_api_secrets)
      .values(row)
      .onConflictDoUpdate({
        target: schema.upstream_api_secrets.id,
        set: {
          nonce: row.nonce,
          tag: row.tag,
          ciphertext: row.ciphertext,
          updated_at: row.updated_at,
          updated_by: row.updated_by,
        },
      })
    await tx.insert(schema.operator_audits).values({
      id: randomUUID(),
      operator_id: operatorId,
      action: 'upstream_secret.replace',
      target_type: 'upstream_secret',
      target_id: slot.id,
      details: { slot: slot.id },
      created_at: updatedAt,
    })
  })
  await refreshUpstreamSecrets()
  return currentView()
}

export async function clearUpstreamSecret(input: {
  slotId: string
  operatorId: string | null
}): Promise<UpstreamSecretsView> {
  const master = readMasterKey()
  if (!master.ok) throw new UpstreamSecretError(master.code, 503, master.reason)
  const slot = requireSlot(input.slotId)
  const operatorId = operatorIdOf(input.operatorId)
  const clearedAt = Date.now()
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(schema.upstream_api_secrets)
      .where(eq(schema.upstream_api_secrets.id, slot.id))
      .returning({ id: schema.upstream_api_secrets.id })
    if (removed.length === 0) return
    await tx.insert(schema.operator_audits).values({
      id: randomUUID(),
      operator_id: operatorId,
      action: 'upstream_secret.clear',
      target_type: 'upstream_secret',
      target_id: slot.id,
      details: { slot: slot.id },
      created_at: clearedAt,
    })
  })
  await refreshUpstreamSecrets()
  return currentView()
}

export interface SecretProbeResult {
  readonly ok: boolean
  readonly httpStatus: number | null
}

interface ProbeDeps {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  record?: (fields: { slot: string; ok: boolean; httpStatus: number | null }) => void
}

function probeTarget(slotId: UpstreamSecretSlotId): { url: string; header: string } {
  if (slotId === 'openai_direct') {
    return { url: `${config.gptDirect.baseUrl}/models`, header: 'authorization' }
  }
  if (slotId === 'gemini') {
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      header: 'x-goog-api-key',
    }
  }
  if (slotId === 'vertex') {
    const base = (
      process.env.VERTEX_BASE_URL?.trim() ||
      'https://aiplatform.googleapis.com/v1/publishers/google'
    ).replace(/\/+$/, '')
    return { url: `${base}/models?pageSize=1`, header: 'x-goog-api-key' }
  }
  return { url: `${config.upstream.baseUrl}/v1/models`, header: 'authorization' }
}

/** Read-only probe. The key is sent only as a header and is never written to the result or the log line. */
export async function testUpstreamSecret(
  slotId: string,
  apiKey: unknown,
  deps: ProbeDeps = {},
): Promise<SecretProbeResult> {
  const slot = requireSlot(slotId)
  const secret = assertSecretMaterial(apiKey)
  const target = probeTarget(slot.id)
  const failed = { ok: false, httpStatus: null }
  if (target.url.includes(secret)) {
    deps.record?.({ slot: slot.id, ...failed })
    return failed
  }
  const headers = new Headers({ accept: 'application/json' })
  headers.set(target.header, target.header === 'authorization' ? `Bearer ${secret}` : secret)
  const fetchImpl = deps.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  let result: SecretProbeResult = failed
  try {
    const response = await fetchImpl(target.url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    })
    result = {
      ok: response.status >= 200 && response.status < 300,
      httpStatus: response.status,
    }
  } catch {
    result = failed
  } finally {
    clearTimeout(timer)
  }
  const fields = { slot: slot.id, ok: result.ok, httpStatus: result.httpStatus }
  deps.record?.(fields)
  if (!deps.record) {
    log.info({ event: 'upstream_secrets.test', ...fields }, 'upstream secret test')
  }
  return result
}
