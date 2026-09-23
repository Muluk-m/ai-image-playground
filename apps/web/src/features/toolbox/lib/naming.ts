/** 产物的名字与体积文字。全是纯函数，工具箱各处（卡片、ZIP、放入输入框）共用一份。 */

const EXTENSION = /\.[^./\\]+$/

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

export function extensionFor(type: string): string {
  return EXTENSIONS[type] ?? type.split('/')[1] ?? 'png'
}

/**
 * 产物文件名：原名去掉扩展名，换成真实字节的那一个。
 * 原名是 `照片.jpeg`、编码器实际给了 PNG 时，落盘的必须是 `照片.png`，否则双击打不开。
 */
export function outputFileName(sourceName: string, type: string): string {
  const base = sourceName.replace(EXTENSION, '') || 'image'
  return `${base}.${extensionFor(type)}`
}

/**
 * 一批产物里重名的挨个加序号。两个文件夹里各有一张 `cover.jpg` 时，
 * ZIP 里同名的后一条会把前一条**覆盖掉**，用户少拿一张图还看不出来。
 */
export function uniqueFileNames(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    const extension = name.match(EXTENSION)?.[0] ?? ''
    const base = extension ? name.slice(0, -extension.length) : name
    let candidate = name
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}${extension}`
    used.add(candidate)
    return candidate
  })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`
}

/** 体积涨跌：`−32%` 是小了，`+6%` 是大了。符号用真的减号，和百分号一起是数据不是文案。 */
export function sizeDeltaLabel(before: number, after: number): string {
  if (before <= 0) return '0%'
  const delta = Math.round((1 - after / before) * 100)
  return delta >= 0 ? `−${delta}%` : `+${-delta}%`
}
