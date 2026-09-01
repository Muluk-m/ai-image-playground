/**
 * 部署产物版本清单（`/version.json`）的读取与「有新版本」判定。
 *
 * 只有 notify=true 的版本才提示；静默版本靠用户自然刷新迁移。清单缺失或格式不对
 * （纯静态形态没写、SPA fallback 返回 HTML）一律当作「无新版本」，不打扰用户。
 */

export interface VersionManifest {
  version: string
  notify: boolean
}

/** 返回「应当提示的新版本号」，没有则 null。 */
export type UpdateChecker = () => Promise<string | null>

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const VERSION_MANIFEST_PATH = '/version.json'
const SKIPPED_VERSION_KEY = 'update-skipped-version'
const FETCH_TIMEOUT_MS = 5000

export function parseVersionManifest(raw: unknown): VersionManifest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { version, notify } = raw as Record<string, unknown>
  if (typeof version !== 'string' || version === '') return null
  return { version, notify: notify === true }
}

export function readSkippedVersion(): string | null {
  try {
    return globalThis.localStorage?.getItem(SKIPPED_VERSION_KEY) ?? null
  } catch {
    return null
  }
}

export function writeSkippedVersion(version: string): void {
  try {
    globalThis.localStorage?.setItem(SKIPPED_VERSION_KEY, version)
  } catch {
    // 隐私模式下存不住：本次会话内不再提示已经够了。
  }
}

/**
 * 自身版本取自**首次成功拉取**的清单，不走构建期注入——注入要穿过 turbo/vite 的
 * env 传递，且纯静态与容器两种形态的构建入口不同，容易只有一边带上版本号。
 */
export function createUpdateChecker(fetcher: Fetcher = fetch): UpdateChecker {
  let bootVersion: string | null = null

  return async () => {
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
}
