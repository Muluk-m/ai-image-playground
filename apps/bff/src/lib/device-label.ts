/** 账户设置里「登录设备」那一行。只认常见浏览器和系统，认不出就说未知。 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent?.trim()
  if (!ua) return '未知设备'
  const browser = browserName(ua)
  const os = osName(ua)
  if (browser === '未知浏览器' && os === '未知系统') return '未知设备'
  return `${browser} · ${os}`
}

function browserName(ua: string): string {
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/OPR\/|Opera/.test(ua)) return 'Opera'
  if (/CriOS\//.test(ua) || (/Chrome\//.test(ua) && !/Chromium/.test(ua))) return 'Chrome'
  if (/FxiOS\//.test(ua) || /Firefox\//.test(ua)) return 'Firefox'
  if (/Safari\//.test(ua)) return 'Safari'
  return '未知浏览器'
}

function osName(ua: string): string {
  // iPhone 的 UA 里带着 "like Mac OS X"，必须先认 iOS。
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS'
  if (/Linux/.test(ua)) return 'Linux'
  return '未知系统'
}
