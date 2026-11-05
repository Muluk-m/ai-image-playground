/**
 * 把模型返回的 SVG 收成静态矢量再入库。
 * 去掉脚本、事件属性、外链和会执行代码的结构；过不了检查就拒绝保存。
 * 响应头另外加 sandbox CSP，两道一起挡住在我们域名下执行脚本。
 *
 * 每一类危险片段都要剥到字符串不再变化。只替换一轮时，
 * `<scr<script>ipt>` 去掉内层后会重新拼出 `<script>`。
 */

const DROPPED_ELEMENTS =
  /<(script|foreignObject|iframe|embed|object|audio|video|link|meta|style|set|animate|animateTransform|animateMotion|handler|mpath)\b[^>]*(?:\/>|>[\s\S]*?<\/\1\s*>)/gi

const OPEN_DROPPED_ELEMENTS =
  /<(script|foreignObject|iframe|embed|object|audio|video|link|meta|style|handler)\b[^>]*\/?>/gi

function stripUntilStable(input: string, pattern: RegExp): string {
  let current = input
  let previous = ''
  while (current !== previous) {
    previous = current
    pattern.lastIndex = 0
    current = current.replace(pattern, '')
  }
  return current
}

export function sanitizeSvg(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes)
    .replace(/^\uFEFF/, '')
    .trim()
  if (!/^<\?xml[\s\S]*<svg[\s>]|^<svg[\s>]/i.test(text)) {
    throw new Error('svg_not_document')
  }
  let xml = stripUntilStable(text, /<!DOCTYPE[\s\S]*?>/gi)
  xml = stripUntilStable(xml, /<!ENTITY[\s\S]*?>/gi)
  xml = stripUntilStable(xml, /<!--|--!?>/g)
  xml = stripUntilStable(xml, DROPPED_ELEMENTS)
  xml = stripUntilStable(xml, OPEN_DROPPED_ELEMENTS)
  xml = stripUntilStable(xml, /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)
  xml = xml.replace(
    /\s+(?:href|xlink:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (full, _quoted: string, doubleQuoted?: string, singleQuoted?: string) => {
      const value = (doubleQuoted ?? singleQuoted ?? '').trim()
      if (value.startsWith('#') && !/script|javascript/i.test(value)) return full
      return ''
    },
  )
  xml = xml.replace(/url\(\s*(['"]?)(?!#)[^)]+\)/gi, 'url(#)')
  if (
    /<\s*script\b|javascript:|data:\s*text\/html|on[a-z]+\s*=|<!ENTITY|<\s*foreignObject\b|<!--/i.test(
      xml,
    )
  ) {
    throw new Error('svg_rejected')
  }
  if (!/<\s*svg[\s>]/i.test(xml)) throw new Error('svg_rejected')
  return new TextEncoder().encode(xml)
}
