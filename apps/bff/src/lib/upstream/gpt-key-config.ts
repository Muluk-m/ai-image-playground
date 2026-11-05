import { createHash } from 'node:crypto'
import { config } from '../../config'
import { runtimeSecret } from '../upstream-secret-cache'

/**
 * GPT Image 直连的密钥清单。
 *
 * 只配 `OPENAI_API_KEY` 时只有一把，月预算仍是 `GPT_DIRECT_MONTHLY_BUDGET_USD`，和以前一样。
 * 配了 `OPENAI_API_KEYS`（逗号分隔、有顺序）就以它为准，`OPENAI_API_KEY_BUDGETS_USD` 必须
 * 一一对应。`OPENAI_API_KEY` 仍给 channels.json 的 openai-images 当渠道密钥，不自动并进这份清单。
 *
 * 指纹是 sha256 十六进制的前 8 位，展示再带上密钥末 4 位。日志和后台只出现这个标签。
 */

export interface DirectKey {
  /** 后台行的 id。环境变量里的密钥没有。 */
  readonly id: string | null
  /** 从 1 开始，配置里的顺序。 */
  readonly ordinal: number
  readonly secret: string
  readonly budgetUsd: number
  /** 后台停用。环境变量密钥恒为 true。 */
  readonly enabled: boolean
  /** sha256 十六进制前 8 位。 */
  readonly fingerprint: string
  /** `指纹…末4位`，可以写进日志。 */
  readonly label: string
}

/**
 * null：后台没有直连密钥，用环境变量。
 * 数组：后台有记录，哪怕解不开或全停用，也不再退回环境变量。
 */
let adminKeys: DirectKey[] | null = null
let adminDeliverable: boolean | null = null

export function resetAdminDirectKeySnapshot(): void {
  adminKeys = null
  adminDeliverable = null
}

/** 刷新后的快照。`admin === null` 表示后台没有记录，退回环境变量。 */
export function noteDirectKeySnapshot(input: {
  admin: DirectKey[] | null
  hardDisabled: ReadonlySet<string>
}): void {
  if (input.admin === null) {
    adminKeys = null
    adminDeliverable = envDirectKeys().some((key) => !input.hardDisabled.has(key.fingerprint))
    return
  }
  adminKeys = input.admin
  adminDeliverable = input.admin.some(
    (key) => key.enabled && !input.hardDisabled.has(key.fingerprint),
  )
}

export function adminDirectKeys(): DirectKey[] | null {
  return adminKeys
}

export function fingerprintOf(secret: string): { fingerprint: string; label: string } {
  const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 8)
  const tail = secret.length >= 4 ? secret.slice(-4) : secret
  return { fingerprint, label: `${fingerprint}…${tail}` }
}

/** 报错和入库前把密钥换成标签。解析失败时不要调用会再抛错的清单。 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(secret, '[redacted]')
  }
  return out.slice(0, 200)
}

export function parseDirectKeyList(rawKeys: string, rawBudgets: string): DirectKey[] {
  const secrets = rawKeys.split(',').map((part) => part.trim())
  if (secrets.length === 0 || secrets.some((secret) => secret === '')) {
    throw new Error('OPENAI_API_KEYS has an empty entry')
  }
  const budgets = rawBudgets.trim() ? rawBudgets.split(',').map((part) => part.trim()) : []
  if (budgets.length !== secrets.length) {
    throw new Error(
      'OPENAI_API_KEY_BUDGETS_USD must list one positive integer for each OPENAI_API_KEYS entry',
    )
  }
  const keys = secrets.map((secret, index) => {
    const budgetUsd = Number(budgets[index])
    if (!Number.isInteger(budgetUsd) || budgetUsd <= 0) {
      throw new Error(`OPENAI_API_KEY_BUDGETS_USD entry ${index + 1} must be a positive integer`)
    }
    return {
      id: null,
      ordinal: index + 1,
      secret,
      budgetUsd,
      enabled: true,
      ...fingerprintOf(secret),
    }
  })
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key.fingerprint)) {
      throw new Error('OPENAI_API_KEYS entries must not share a fingerprint')
    }
    seen.add(key.fingerprint)
  }
  return keys
}

function envDirectKeys(): DirectKey[] {
  const list = process.env.OPENAI_API_KEYS?.trim()
  if (list) return parseDirectKeyList(list, process.env.OPENAI_API_KEY_BUDGETS_USD ?? '')
  const single = runtimeSecret('OPENAI_API_KEY', config.gptDirect.apiKey).trim()
  if (!single) return []
  return [
    {
      id: null,
      ordinal: 1,
      secret: single,
      budgetUsd: config.gptDirect.monthlyBudgetUsd,
      enabled: true,
      ...fingerprintOf(single),
    },
  ]
}

/**
 * 后台「直连」页有记录时只用那些。没有记录时：OPENAI_API_KEYS，否则
 * OPENAI_API_KEY（含上游密钥页替换的那一把）加环境变量预算。
 */
export function configuredDirectKeys(): DirectKey[] {
  if (adminKeys !== null) return adminKeys
  return envDirectKeys()
}

/** 渠道 size 能力：直连开着，且至少有一把没被管理员停用、也没因额度或失效被停掉。 */
export function gptDirectSizeEnabled(): boolean {
  if (process.env.GPT_DIRECT_ENABLED?.trim().toLowerCase() !== 'true') return false
  if (adminDeliverable !== null) return adminDeliverable
  return envDirectKeys().length > 0
}

export function directKeySecrets(): string[] {
  const secrets = [process.env.OPENAI_API_KEY ?? '', process.env.OPENAI_ADMIN_KEY ?? '']
  try {
    secrets.push(...configuredDirectKeys().map((key) => key.secret))
  } catch {
    // 配置不合法时也要能把已经出现在报错里的密钥抹掉。
  }
  return secrets.filter((secret) => secret !== '')
}
