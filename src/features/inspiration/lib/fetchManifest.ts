import type { InspirationManifest } from '../types'
import { getApiErrorMessage } from '../../../lib/imageApiShared'

export const DEFAULT_REMOTE_MANIFEST_URL =
  'https://raw.githubusercontent.com/qiliangjia/qlj-image-playground-inspirations/main/manifest.json'

/** 解析构建期注入的 URL；空字符串视为「禁用远程」。 */
export function resolveRemoteManifestUrl(): string | null {
  const envUrl = import.meta.env.VITE_INSPIRATION_MANIFEST_URL
  if (typeof envUrl === 'string') {
    const trimmed = envUrl.trim()
    if (!trimmed) return null
    return trimmed
  }
  return DEFAULT_REMOTE_MANIFEST_URL
}

/**
 * 拉取远程 manifest。失败抛 Error；调用者负责 toast/降级。
 *
 * 协议：标准 fetch + JSON，错误归一化为 Error。
 */
export async function fetchRemoteManifest(url: string, signal?: AbortSignal): Promise<InspirationManifest> {
  const response = await fetch(url, { method: 'GET', signal })
  if (!response.ok) {
    throw new Error(`远程灵感清单加载失败：${await getApiErrorMessage(response)}`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('远程灵感清单返回非 JSON 内容')
  }
  const manifest = validateManifest(payload)
  if (!manifest) {
    throw new Error('远程灵感清单结构无效')
  }
  return manifest
}

function validateManifest(payload: unknown): InspirationManifest | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.version !== 'number') return null
  if (typeof record.updatedAt !== 'string') return null
  if (!Array.isArray(record.items)) return null

  const items = record.items.filter((it) => {
    if (!it || typeof it !== 'object') return false
    const r = it as Record<string, unknown>
    return (
      typeof r.id === 'string' &&
      typeof r.title === 'string' &&
      typeof r.prompt === 'string' &&
      typeof r.thumbnailUrl === 'string' &&
      r.params && typeof r.params === 'object' &&
      typeof (r.params as Record<string, unknown>).size === 'string' &&
      typeof r.recommendedModel === 'string' &&
      typeof r.recommendedProvider === 'string' &&
      typeof r.category === 'string'
    )
  })

  return {
    version: record.version,
    updatedAt: record.updatedAt,
    items: items as InspirationManifest['items'],
    categories: Array.isArray(record.categories) ? record.categories.map(String) : undefined,
  }
}
