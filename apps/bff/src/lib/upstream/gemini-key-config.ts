import { scryptSync } from 'node:crypto'
import { log } from '../logger'
import { runtimeSecret } from '../upstream-secret-cache'
import { fingerprintMacSource } from './gpt-direct-availability'
import { FingerprintSecretMissingError, scrubSecrets } from './gpt-key-config'

/**
 * Gemini 直连（Vertex / Nano Banana）密钥清单与进程内快照。
 * 刻意不依赖 db/client 或 channels.ts，避免与渠道加载产生循环依赖。
 */

export interface GeminiDirectKey {
  readonly id: string | null
  readonly ordinal: number
  readonly secret: string
  readonly budgetUsd: number
  readonly enabled: boolean
  readonly fingerprint: string
  readonly label: string
}

let adminSnapshot: GeminiDirectKey[] | null = null
let knownHardDisabled: ReadonlySet<string> = new Set()

export function adminGeminiDirectKeys(): GeminiDirectKey[] | null {
  return adminSnapshot
}

export function geminiDirectKeyKnownDisabled(fingerprint: string): boolean {
  return knownHardDisabled.has(fingerprint)
}

export function forgetGeminiDirectKeyDisabled(fingerprint: string): void {
  if (!knownHardDisabled.has(fingerprint)) return
  const next = new Set(knownHardDisabled)
  next.delete(fingerprint)
  knownHardDisabled = next
}

export function setAdminGeminiDirectKeySnapshot(
  keys: GeminiDirectKey[] | null,
  hardDisabled?: ReadonlySet<string>,
): void {
  adminSnapshot = keys
  if (hardDisabled !== undefined) knownHardDisabled = new Set(hardDisabled)
}

export function resetAdminGeminiDirectKeySnapshot(): void {
  adminSnapshot = null
  knownHardDisabled = new Set()
}

export function geminiDirectEnabledKeyCount(): number {
  return (adminSnapshot ?? safeEnvGeminiDirectKeys()).filter(
    (key) => key.enabled && !knownHardDisabled.has(key.fingerprint),
  ).length
}

const FINGERPRINT_SALT_PREFIX = 'gemini-direct-key-fingerprint-v1'
const fingerprintCache = new Map<string, { fingerprint: string; label: string }>()

function fingerprintSecretValue(): string {
  const source = fingerprintMacSource()
  const value = source === 'unset' ? '' : (process.env[source]?.trim() ?? '')
  if (!value) throw new FingerprintSecretMissingError()
  return value
}

export function geminiFingerprintOf(secret: string): { fingerprint: string; label: string } {
  const serverSecret = fingerprintSecretValue()
  const cacheKey = `${fingerprintMacSource()}\0${serverSecret}\0${secret}`
  const cached = fingerprintCache.get(cacheKey)
  if (cached) return cached
  const digest = scryptSync(secret, `${FINGERPRINT_SALT_PREFIX}:${serverSecret}`, 16, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  const fingerprint = digest.subarray(0, 4).toString('hex')
  const tail = secret.length >= 4 ? secret.slice(-4) : secret
  const result = { fingerprint, label: `${fingerprint}…${tail}` }
  fingerprintCache.set(cacheKey, result)
  return result
}

function monthlyBudgetUsd(): number {
  const raw = process.env.GEMINI_DIRECT_MONTHLY_BUDGET_USD?.trim()
  if (!raw) return 200
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('GEMINI_DIRECT_MONTHLY_BUDGET_USD must be a positive integer')
  }
  return value
}

function legacySingleKey(secret: string): GeminiDirectKey {
  const tail = secret.length >= 4 ? secret.slice(-4) : secret
  return {
    id: null,
    ordinal: 1,
    secret,
    budgetUsd: monthlyBudgetUsd(),
    enabled: true,
    fingerprint: 'legacy',
    label: `legacy…${tail}`,
  }
}

export function parseGeminiDirectKeyList(rawKeys: string, rawBudgets: string): GeminiDirectKey[] {
  const secrets = rawKeys.split(',').map((part) => part.trim())
  if (secrets.length === 0 || secrets.some((secret) => secret === '')) {
    throw new Error('VERTEX_API_KEYS has an empty entry')
  }
  const budgets = rawBudgets.trim() ? rawBudgets.split(',').map((part) => part.trim()) : []
  if (budgets.length !== secrets.length) {
    throw new Error(
      'VERTEX_API_KEY_BUDGETS_USD must list one positive integer for each VERTEX_API_KEYS entry',
    )
  }
  const keys = secrets.map((secret, index) => {
    const budgetUsd = Number(budgets[index])
    if (!Number.isInteger(budgetUsd) || budgetUsd <= 0) {
      throw new Error(`VERTEX_API_KEY_BUDGETS_USD entry ${index + 1} must be a positive integer`)
    }
    return {
      id: null,
      ordinal: index + 1,
      secret,
      budgetUsd,
      enabled: true,
      ...geminiFingerprintOf(secret),
    }
  })
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key.fingerprint)) {
      throw new Error('VERTEX_API_KEYS entries must not share a fingerprint')
    }
    seen.add(key.fingerprint)
  }
  return keys
}

export function envGeminiDirectKeys(): GeminiDirectKey[] {
  const list = process.env.VERTEX_API_KEYS?.trim()
  if (list) return parseGeminiDirectKeyList(list, process.env.VERTEX_API_KEY_BUDGETS_USD ?? '')
  const single = runtimeSecret('VERTEX_API_KEY', process.env.VERTEX_API_KEY?.trim() ?? '').trim()
  if (!single) return []
  if (fingerprintMacSource() === 'unset') return [legacySingleKey(single)]
  return [
    {
      id: null,
      ordinal: 1,
      secret: single,
      budgetUsd: monthlyBudgetUsd(),
      enabled: true,
      ...geminiFingerprintOf(single),
    },
  ]
}

export function safeEnvGeminiDirectKeys(): GeminiDirectKey[] {
  try {
    return envGeminiDirectKeys()
  } catch (err) {
    log.warn(
      { event: 'gemini.direct_keys_invalid', err: err instanceof Error ? err.name : 'error' },
      'gemini direct key config is invalid',
    )
    return []
  }
}

/** 后台有配置时只走后台清单，否则退回环境变量 VERTEX_API_KEYS / VERTEX_API_KEY。 */
export function configuredGeminiDirectKeys(): GeminiDirectKey[] {
  if (adminSnapshot !== null) return adminSnapshot
  return envGeminiDirectKeys()
}

/** 是否启用了 Gemini 密钥池（后台有记录或环境变量配了 Vertex key）。 */
export function hasGeminiDirectPool(): boolean {
  if (adminSnapshot !== null) return true
  return safeEnvGeminiDirectKeys().length > 0
}

export function geminiDirectKeySecrets(): string[] {
  const secrets = [
    process.env.VERTEX_API_KEY ?? '',
    ...(process.env.VERTEX_API_KEYS ?? '').split(','),
  ]
  try {
    secrets.push(...configuredGeminiDirectKeys().map((key) => key.secret))
  } catch {
    // 忽略配置错误，尽量把已知密钥抹掉
  }
  return secrets.map((secret) => secret.trim()).filter((secret) => secret !== '')
}

export function displayGeminiKeyError(raw: string | null): string | null {
  if (!raw) return null
  const text = scrubSecrets(raw, geminiDirectKeySecrets())
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]')
    .replace(/AQ\.[0-9A-Za-z_.-]{10,}/g, '[redacted]')
  return text.slice(0, 200)
}
