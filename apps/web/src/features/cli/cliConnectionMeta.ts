const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVE_WINDOW_MS = 7 * DAY_MS
const EXPIRING_SOON_WINDOW_MS = 7 * DAY_MS

export interface ParsedCliUserAgent {
  readonly version: string | null
  readonly platform: string | null
}

export type CliCapabilityTag = 'generate' | 'reference' | 'jobs'

const CLI_UA_PATTERN = /^muvloom-cli\/([^\s()]+)(?:\s*\(([^/()\s]+)\/([^/()\s]+)\))?/i

function formatOs(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower === 'darwin' || lower === 'macos') return 'macOS'
  if (lower === 'windows' || lower === 'win32') return 'Windows'
  if (lower === 'linux') return 'Linux'
  return raw
}

function formatArch(raw: string, os: string): string {
  const lower = raw.toLowerCase()
  if (lower === 'arm64' || lower === 'aarch64') {
    return os.toLowerCase() === 'darwin' ? 'Apple Silicon' : 'ARM64'
  }
  if (lower === 'amd64' || lower === 'x86_64' || lower === 'x64') return 'x64'
  if (lower === '386' || lower === 'x86') return 'x86'
  return raw
}

/** 解析 `muvloom-cli/0.2.7 (darwin/arm64)` 这类客户端标识为可读版本与系统平台。 */
export function parseCliUserAgent(userAgent: string | null | undefined): ParsedCliUserAgent {
  const trimmed = userAgent?.trim()
  if (!trimmed) return { version: null, platform: null }
  const match = CLI_UA_PATTERN.exec(trimmed)
  if (!match) return { version: null, platform: null }
  const rawVersion = match[1] ?? ''
  const version =
    rawVersion && rawVersion.toLowerCase() !== 'dev'
      ? rawVersion.startsWith('v')
        ? rawVersion
        : `v${rawVersion}`
      : rawVersion || null
  const rawOs = match[2]
  const rawArch = match[3]
  const platform =
    rawOs && rawArch
      ? `${formatOs(rawOs)} · ${formatArch(rawArch, rawOs)}`
      : rawOs
        ? formatOs(rawOs)
        : null
  return { version, platform }
}

/** 取连接 UUID 的前 6 位十六进制作为短标识，区分同名多设备连接。 */
export function shortConnectionId(id: string): string {
  const compact = id.replace(/-/g, '').slice(0, 6).toLowerCase()
  return `#${compact || id}`
}

/** 将后端 OAuth scopes 折叠成与授权页一致的能力标签。 */
export function connectionCapabilities(scopes: readonly string[] | undefined): CliCapabilityTag[] {
  if (!scopes || scopes.length === 0) return []
  const set = new Set(scopes)
  const tags: CliCapabilityTag[] = []
  if (set.has('images:write')) tags.push('generate')
  if (set.has('media:write')) tags.push('reference')
  if (set.has('images:read') || set.has('media:read')) tags.push('jobs')
  return tags
}

export function isRecentlyActive(lastUsedAt: number | null, now: number): boolean {
  return lastUsedAt !== null && now - lastUsedAt <= ACTIVE_WINDOW_MS
}

export function isExpiringSoon(expiresAt: number | undefined, now: number): boolean {
  return expiresAt !== undefined && expiresAt - now <= EXPIRING_SOON_WINDOW_MS
}

export function formatShortDate(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  })
}

/** 7 天内显示相对时间（如「2 小时前」），更早显示紧凑日期时间。 */
export function formatRecentActivity(timestamp: number, now: number, locale: string): string {
  const diffMs = now - timestamp
  if (diffMs >= 0 && diffMs < ACTIVE_WINDOW_MS && typeof Intl.RelativeTimeFormat === 'function') {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
    const minutes = Math.floor(diffMs / 60_000)
    if (minutes < 1) return rtf.format(0, 'second')
    if (minutes < 60) return rtf.format(-minutes, 'minute')
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return rtf.format(-hours, 'hour')
    const days = Math.floor(hours / 24)
    return rtf.format(-days, 'day')
  }
  return new Date(timestamp).toLocaleString(locale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
