import type { VolumeBucketUnit } from './types'

/** 8 字短码（取首 8 char），如 'aa11-22bb' → 'aa11-22b' */
export function shortId(id: string, len = 8): string {
  return id.length <= len ? id : id.slice(0, len)
}

/** 相对时间（"5 min ago" / "刚刚" / "在未来"） */
export function fuzzyTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts
  if (diff < 0) {
    const abs = -diff
    if (abs < 60_000) return '即将'
    return `${Math.round(abs / 60_000)} 分钟后`
  }
  if (diff < 5_000) return '刚刚'
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`
  if (diff < 3600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)} 小时前`
  if (diff < 30 * 86400_000) return `${Math.round(diff / 86400_000)} 天前`
  return new Date(ts).toLocaleDateString()
}

export function isoTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
}

/** 持续时间 "12s" / "1m 24s" / "—" */
export function duration(startedAt: number | null, completedAt: number | null): string {
  if (!startedAt || !completedAt) return '—'
  const ms = completedAt - startedAt
  if (ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  return rs === 0 ? `${m}m` : `${m}m ${rs}s`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 图表时间轴刻度：按小时聚合走 HH:00，按天聚合走 MM-DD */
export function volumeTick(ts: number, unit: VolumeBucketUnit): string {
  const date = new Date(ts)
  return unit === 'hour'
    ? `${pad(date.getHours())}:00`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** copy to clipboard with a small fallback for non-secure contexts */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fallthrough
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
