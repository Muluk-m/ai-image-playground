import { useMemo } from 'react'

export interface PromptDiffPart {
  kind: 'same' | 'removed' | 'added'
  text: string
}
const tokens = (text: string) => text.match(/\s+|\p{Script=Han}|[^\s\p{Script=Han}]+/gu) ?? []

export function diffPrompts(original: string, submitted: string): PromptDiffPart[] {
  if (original === submitted) return [{ kind: 'same', text: submitted }]
  const a = tokens(original)
  const b = tokens(submitted)
  // Long prompts remain readable without allocating an unbounded quadratic matrix.
  if (a.length * b.length > 250_000)
    return [
      { kind: 'removed', text: original },
      { kind: 'added', text: submitted },
    ]
  const width = b.length + 1
  const lengths = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!)
    }
  }
  const result: PromptDiffPart[] = []
  const append = (kind: PromptDiffPart['kind'], text: string) => {
    const last = result[result.length - 1]
    if (last?.kind === kind) last.text += text
    else result.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      append('same', a[i++]!)
      j++
    } else if (
      i < a.length &&
      (j === b.length || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)
    ) {
      append('removed', a[i++]!)
    } else append('added', b[j++]!)
  }
  return result
}

export function PromptDiff({ original, submitted }: { original: string; submitted: string }) {
  const parts = useMemo(() => diffPrompts(original, submitted), [original, submitted])
  return (
    <div
      className="whitespace-pre-wrap break-words font-mono text-xs leading-5"
      aria-label="提示词修改差异"
    >
      {parts.map((part, index) =>
        part.kind === 'removed' ? (
          <del key={`${index}-${part.kind}`} className="bg-danger/10 text-danger">
            {part.text}
          </del>
        ) : part.kind === 'added' ? (
          <ins key={`${index}-${part.kind}`} className="bg-success/10 text-success no-underline">
            {part.text}
          </ins>
        ) : (
          <span key={`${index}-${part.kind}`}>{part.text}</span>
        ),
      )}
    </div>
  )
}
