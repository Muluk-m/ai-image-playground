import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect } from 'react'

/** PROTOTYPE — 交互稿底部切换条。生产构建不渲染，防止误合并后暴露给运营者。 */

export interface VariantMeta<K extends string> {
  key: K
  name: string
  summary: string
}

interface Props<K extends string> {
  variants: readonly VariantMeta<K>[]
  current: K
  onChange: (next: K) => void
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function PrototypeSwitcher<K extends string>({ variants, current, onChange }: Props<K>) {
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  )
  const prev = variants[(index - 1 + variants.length) % variants.length]
  const next = variants[(index + 1) % variants.length]
  const meta = variants[index]

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return
      if (event.key === 'ArrowLeft') onChange(prev.key)
      if (event.key === 'ArrowRight') onChange(next.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev.key, next.key, onChange])

  if (import.meta.env.PROD) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[200] flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-400/60 bg-amber-50 px-2 py-1 text-amber-950 shadow-lg ring-1 ring-black/5 dark:bg-amber-200">
        <button
          type="button"
          onClick={() => onChange(prev.key)}
          className="rounded-full p-1 hover:bg-amber-200/70"
          aria-label="上一个变体"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="flex min-w-[260px] flex-col items-center leading-tight">
          <span className="text-xs font-semibold tracking-wide">
            交互稿 {meta.key} · {meta.name}
          </span>
          <span className="text-[11px] text-amber-900/80">{meta.summary}</span>
        </div>
        <button
          type="button"
          onClick={() => onChange(next.key)}
          className="rounded-full p-1 hover:bg-amber-200/70"
          aria-label="下一个变体"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  )
}
