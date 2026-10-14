import { canonicalPath } from './pages'

/** 源稿里还没填上的事实。`{{¥39套餐积分}}` 这种整句删掉，不留占位符，也不补一个数。 */
const PLACEHOLDER = /\{\{[^{}]*\}\}/

const CANONICAL_ORIGIN = 'https://muvloom.online'

/**
 * 把 `llms.txt` 源稿收成可以发布的文本。
 *
 * - 含未填占位符的句子（以 `。` / `；` 分句）整句删掉。一行都空了就删行。
 * - 指向尚未登记的站内页面的链接整行删掉。页面写进 `PRERENDERED_PAGES` 之后，同一行会留下。
 * - 有 `PUBLIC_ORIGIN` 时，源稿里的生产域名换成它；没有就不猜域名，改成站内路径。
 */
export function renderLlmsTxt(
  source: string,
  options: { origin: string | null; paths: ReadonlySet<string> },
): string {
  const kept: string[] = []
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const resolved = dropUnresolved(line)
    if (resolved == null) continue
    if (!linksAreIndexable(resolved, options.paths)) continue
    kept.push(rewriteOrigin(resolved, options.origin))
  }
  return `${collapse(dropEmptyHeadings(kept)).join('\n')}\n`
}

function dropUnresolved(line: string): string | null {
  if (!PLACEHOLDER.test(line)) return line
  const parts = line.split(/([。；])/)
  let out = ''
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index] ?? ''
    const delimiter = parts[index + 1] ?? ''
    if (text.trim() === '' || PLACEHOLDER.test(text)) continue
    out += text + delimiter
  }
  out = out.replace(/[；。]+$/g, '').trim()
  if (out === '' || PLACEHOLDER.test(out)) return null
  if (/^[-*]\s*[^：:]*[：:]\s*$/.test(out)) return null
  return out
}

function linksAreIndexable(line: string, paths: ReadonlySet<string>): boolean {
  for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const path = sitePath(match[1] ?? '')
    if (path != null && !paths.has(path)) return false
  }
  return true
}

function sitePath(href: string): string | null {
  const withoutHash = href.split('#')[0] ?? href
  if (withoutHash.startsWith('/')) return canonicalPath(withoutHash)
  if (withoutHash === CANONICAL_ORIGIN || withoutHash.startsWith(`${CANONICAL_ORIGIN}/`)) {
    return canonicalPath(withoutHash.slice(CANONICAL_ORIGIN.length) || '/')
  }
  return null
}

function rewriteOrigin(line: string, origin: string | null): string {
  return line.split(CANONICAL_ORIGIN).join(origin ?? '')
}

function dropEmptyHeadings(lines: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (!/^#{1,6} /.test(line)) {
      result.push(line)
      continue
    }
    let next = index + 1
    while (next < lines.length && (lines[next] ?? '').trim() === '') next++
    if (next >= lines.length || /^#{1,6} /.test(lines[next] ?? '')) continue
    result.push(line)
  }
  return result
}

function collapse(lines: string[]): string[] {
  const result: string[] = []
  for (const line of lines) {
    if (line.trim() === '' && (result.length === 0 || result[result.length - 1] === '')) continue
    result.push(line)
  }
  while (result[0] === '') result.shift()
  while (result[result.length - 1] === '') result.pop()
  return result
}
