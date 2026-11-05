import { runtimeSecret } from '../upstream-secret-cache'
import type { DirectKey } from './gpt-key-config'

/**
 * 直连 size 能力用的快照。不读 config、不连数据库：渠道清单的单测不能因为这层判断去要 DATABASE_URL。
 * 后台密钥刷新后写入；没刷新过就只看环境变量里有没有 key。
 */

let adminKeys: DirectKey[] | null = null
let adminDeliverable: boolean | null = null

export function resetAdminDirectKeySnapshot(): void {
  adminKeys = null
  adminDeliverable = null
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
}

/** 开关打开，且至少有一把可用直连密钥（含后台配置的）。 */
export function gptDirectSizeEnabled(): boolean {
  if (process.env.GPT_DIRECT_ENABLED?.trim().toLowerCase() !== 'true') return false
  if (adminDeliverable !== null) return adminDeliverable
  return Boolean(
    process.env.OPENAI_API_KEYS?.trim() ||
      runtimeSecret('OPENAI_API_KEY', process.env.OPENAI_API_KEY?.trim() ?? ''),
  )
}
