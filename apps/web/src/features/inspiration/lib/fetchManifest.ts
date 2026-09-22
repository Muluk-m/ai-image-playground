import { INSPIRATION_KINDS, type InspirationKind } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { getApiErrorMessage } from '../../../lib/imageApiShared'
import { bffBaseUrl, getRuntimeConfig } from '../../../lib/runtimeConfig'
import type { InspirationManifest } from '../types'

/**
 * Paid deployments read the BFF's published manifest; the static file remains an offline/BYOK
 * seed for builds with no BFF. A build-time URL may still point a staging build at another API.
 */
export const DEFAULT_REMOTE_MANIFEST_URL = '/inspiration-manifest.json'

export function resolveRemoteManifestUrl(): string | null {
  const envUrl = import.meta.env.VITE_INSPIRATION_MANIFEST_URL
  if (typeof envUrl === 'string') {
    const trimmed = envUrl.trim()
    if (!trimmed) return null
    return trimmed
  }
  return getRuntimeConfig().bff.enabled
    ? `${bffBaseUrl()}/api/inspirations/manifest`
    : DEFAULT_REMOTE_MANIFEST_URL
}

/**
 * 拉取远程 manifest。失败抛 Error；调用者负责 toast/降级。
 *
 * 协议：标准 fetch + JSON，错误归一化为 Error。
 */
export async function fetchRemoteManifest(
  url: string,
  signal?: AbortSignal,
): Promise<InspirationManifest> {
  const response = await fetch(url, {
    method: 'GET',
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(
      i18next.t('manifest.loadFailed', {
        ns: 'inspiration',
        reason: await getApiErrorMessage(response),
      }),
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(i18next.t('manifest.notJson', { ns: 'inspiration' }))
  }
  const manifest = validateManifest(payload)
  if (!manifest) {
    throw new Error(i18next.t('manifest.invalid', { ns: 'inspiration' }))
  }
  return manifest
}

function validateManifest(payload: unknown): InspirationManifest | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.version !== 'number') return null
  if (typeof record.updatedAt !== 'string') return null
  if (!Array.isArray(record.items)) return null

  // 旧的静态 manifest（BYOK / 离线种子）没有 kind：按效果图收下，别整份判无效。
  const items = record.items.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const r = entry as Record<string, unknown>
    const valid =
      typeof r.id === 'string' &&
      typeof r.title === 'string' &&
      typeof r.prompt === 'string' &&
      typeof r.thumbnailUrl === 'string' &&
      r.params &&
      typeof r.params === 'object' &&
      typeof (r.params as Record<string, unknown>).size === 'string' &&
      typeof r.recommendedModel === 'string' &&
      typeof r.recommendedProvider === 'string' &&
      typeof r.category === 'string'
    if (!valid) return []
    const kind = INSPIRATION_KINDS.includes(r.kind as InspirationKind)
      ? (r.kind as InspirationKind)
      : 'showcase'
    return [{ ...(entry as InspirationManifest['items'][number]), kind }]
  })

  return {
    version: record.version,
    updatedAt: record.updatedAt,
    items,
    categories: Array.isArray(record.categories) ? record.categories.map(String) : undefined,
  }
}
