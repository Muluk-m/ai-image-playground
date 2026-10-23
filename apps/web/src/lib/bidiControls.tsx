import type { ReactNode } from 'react'

// 显式方向控制符（LRE/RLE/PDF/LRO/RLO 与 LRI/RLI/FSI/PDI）会改写它之后整段文字的显示
// 顺序：用户输入里的一个 U+202E 就能让 `invoice‮fdp.exe` 看起来像 `invoiceexe.pdf`。
// 只在显示时把它们换成看得见的 `U+XXXX` 标记，原文（重新编辑、发给模型）一字不动。
// LRM/RLM 这类只影响相邻中性字符的标记不在其列，保留原样。
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g

export function visibleBidiControls(text: string, keyPrefix = 'bidi'): ReactNode[] {
  const parts: ReactNode[] = []
  let from = 0
  for (const match of text.matchAll(BIDI_CONTROLS)) {
    const at = match.index ?? 0
    if (at > from) parts.push(text.slice(from, at))
    const code = `U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
    parts.push(
      <span
        key={`${keyPrefix}-${at}`}
        data-bidi-control={code}
        className="mx-px rounded-sm bg-foreground/10 px-0.5 font-mono text-label-sm text-muted-foreground"
      >
        {code}
      </span>,
    )
    from = at + match[0].length
  }
  if (from < text.length || parts.length === 0) parts.push(text.slice(from))
  return parts
}
