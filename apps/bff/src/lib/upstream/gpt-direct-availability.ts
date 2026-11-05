import { runtimeSecret } from '../upstream-secret-cache'
import type { DirectKey } from './gpt-key-config'

/**
 * 直连 size 能力用的快照。不读 config、不连数据库：渠道清单的单测不能因为这层判断去要 DATABASE_URL。
 * 后台密钥刷新后写入；没刷新过就只看环境变量里有没有 key。
 * 指纹密钥的变量名也放在这里，渠道判断和指纹计算共用一份，避免两处名单分叉。
 */

export const FINGERPRINT_SECRET_ENVS = [
  'INTERNAL_API_TOKEN',
  'EMAIL_CODE_SECRET',
  'UPSTREAM_SECRETS_MASTER_KEY',
] as const

export type FingerprintMacSource = (typeof FINGERPRINT_SECRET_ENVS)[number] | 'unset'

/** 指纹用哪一个环境变量。只返回名字。 */
export function fingerprintMacSource(): FingerprintMacSource {
  for (const name of FINGERPRINT_SECRET_ENVS) {
    if (process.env[name]?.trim()) return name
  }
  return 'unset'
}

export function fingerprintSecretConfigured(): boolean {
  return fingerprintMacSource() !== 'unset'
}

let adminKeys: DirectKey[] | null = null
let adminDeliverable: boolean | null = null
/** 后台快照里启用的 key 数。`null` 表示没有后台记录，退回环境变量。 */
let adminEnabledCount: number | null = null

export function resetAdminDirectKeySnapshot(): void {
  adminKeys = null
  adminDeliverable = null
  adminEnabledCount = null
}

export function adminDirectKeys(): DirectKey[] | null {
  return adminKeys
}

export function setAdminDirectKeySnapshot(
  keys: DirectKey[] | null,
  deliverable: boolean | null,
): void {
  adminKeys = keys
  adminDeliverable = deliverable
  adminEnabledCount = keys === null ? null : keys.filter((key) => key.enabled).length
}

function directSwitchOn(): boolean {
  return (
    process.env.GPT_DIRECT_ENABLED?.trim().toLowerCase() === 'true' && fingerprintSecretConfigured()
  )
}

function envKeyCount(): number {
  const list = process.env.OPENAI_API_KEYS?.trim()
  if (list) return list.split(',').filter((part) => part.trim()).length
  return runtimeSecret('OPENAI_API_KEY', process.env.OPENAI_API_KEY?.trim() ?? '') ? 1 : 0
}

/**
 * 渠道能不能留下 openai-images。后台快照里启用的 key 也算，这样清掉环境变量之后模型还在。
 * 没刷新过才看环境变量。不连数据库。
 */
export function gptDirectEnabledKeyCount(): number {
  if (!directSwitchOn()) return 0
  if (adminEnabledCount !== null) return adminEnabledCount
  return envKeyCount()
}

/** 开关打开，且至少有一把此刻还能用的直连密钥（含后台配置的）。 */
export function gptDirectSizeEnabled(): boolean {
  if (!directSwitchOn()) return false
  if (adminDeliverable !== null) return adminDeliverable
  return envKeyCount() > 0
}
