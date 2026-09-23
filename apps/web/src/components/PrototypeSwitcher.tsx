// PROTOTYPE — throwaway：原型的变体切换条。`?variant=` 决定当前变体，← / → 键或两侧箭头循环切换。
// 只在开发构建出现，生产构建里整条不渲染、也不挂键盘监听。

import { useEffect, useState } from 'react'

function readVariant(keys: readonly string[]): string {
  const value = new URLSearchParams(window.location.search).get('variant')
  return value && keys.includes(value) ? value : keys[0]
}

export function useVariantParam(keys: readonly string[]) {
  const [variant, setVariant] = useState(() => readVariant(keys))
  useEffect(() => {
    const onPop = () => setVariant(readVariant(keys))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [keys])
  const change = (next: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', next)
    window.history.replaceState(window.history.state, '', url)
    setVariant(next)
  }
  return [variant, change] as const
}

function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export default function PrototypeSwitcher({
  variants,
  current,
  onChange,
}: {
  variants: readonly { key: string; name: string }[]
  current: string
  onChange: (key: string) => void
}) {
  const index = Math.max(
    0,
    variants.findIndex((variant) => variant.key === current),
  )
  const step = (delta: number) =>
    onChange(variants[(index + delta + variants.length) % variants.length].key)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const onKey = (event: KeyboardEvent) => {
      if (typingInto(event.target)) return
      if (event.key === 'ArrowLeft') step(-1)
      if (event.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!import.meta.env.DEV) return null
  const active = variants[index]
  return (
    <div className="fixed bottom-20 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-1 rounded-full bg-neutral-950 p-1 text-xs text-white shadow-2xl ring-1 ring-white/15 md:bottom-5">
      <button
        type="button"
        onClick={() => step(-1)}
        className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"
        aria-label="上一个变体"
      >
        ←
      </button>
      <span className="min-w-40 px-2 text-center font-medium">
        {active.key} · {active.name}
        <span className="ml-2 text-white/50">
          {index + 1}/{variants.length}
        </span>
      </span>
      <button
        type="button"
        onClick={() => step(1)}
        className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"
        aria-label="下一个变体"
      >
        →
      </button>
    </div>
  )
}
