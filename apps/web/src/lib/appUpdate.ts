/**
 * 部署产物版本清单（`/version.json`）的读取与「有新版本」判定。
 *
 * 清单缺失或格式不对（未产出清单的部署形态、SPA fallback 回了 index.html）一律
 * 当作「无新版本」，不打扰用户。
 */
import { safeLocalStorage } from './authScope'

export interface VersionManifest {
  version: string
  notify: boolean
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const VERSION_MANIFEST_PATH = '/version.json'
const SKIPPED_VERSION_KEY = 'update-skipped-version'
const FETCH_TIMEOUT_MS = 5000

/**
 * 自身版本 = 首次成功拉取到的版本，跟 runtimeConfig 的 `cached` 一样是 boot 到刷新
 * 之间的常量。放模块级而不是组件里：重挂载会重新锚定到刚发布的版本，从此不再提示。
 */
let bootVersion: string | null = null

export function parseVersionManifest(raw: unknown): VersionManifest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { version, notify } = raw as Record<string, unknown>
  if (typeof version !== 'string' || version === '') return null
  return { version, notify: notify === true }
}

export function readSkippedVersion(): string | null {
  return safeLocalStorage.getItem(SKIPPED_VERSION_KEY)
}

export function writeSkippedVersion(version: string): void {
  safeLocalStorage.setItem(SKIPPED_VERSION_KEY, version)
}

/** 返回「应当提示的新版本号」，没有则 null。 */
export async function checkForUpdate(fetcher: Fetcher = fetch): Promise<string | null> {
  let manifest: VersionManifest | null
  try {
    const res = await fetcher(VERSION_MANIFEST_PATH, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    manifest = parseVersionManifest(await res.json())
  } catch {
    return null
  }
  if (!manifest) return null

  if (bootVersion === null) {
    bootVersion = manifest.version
    return null
  }
  if (manifest.version === bootVersion) return null
  if (!manifest.notify) return null
  if (manifest.version === readSkippedVersion()) return null
  return manifest.version
}

/** 仅供测试：丢掉已锚定的自身版本。 */
export function _resetBootVersionForTesting(): void {
  bootVersion = null
}
