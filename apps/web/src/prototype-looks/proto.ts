// PROTOTYPE（#753）：整目录是可丢弃代码，不进 main。
// 打开方式：dev server 下任意页面加 `?proto=looks&variant=A|B|C`。
import { useEffect, useState } from 'react'

export const VARIANTS = ['A', 'B', 'C'] as const
export type Variant = (typeof VARIANTS)[number]

export function isProto(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('proto') === 'looks'
}

function readVariant(): Variant {
  const raw = new URLSearchParams(window.location.search).get('variant')?.toUpperCase()
  return (VARIANTS as readonly string[]).includes(raw ?? '') ? (raw as Variant) : 'A'
}

const listeners = new Set<() => void>()

export function setVariant(next: Variant) {
  const url = new URL(window.location.href)
  url.searchParams.set('variant', next)
  window.history.replaceState(window.history.state, '', url)
  for (const fn of listeners) fn()
}

export function useVariant(): Variant {
  const [variant, set] = useState<Variant>(() => (isProto() ? readVariant() : 'A'))
  useEffect(() => {
    const fn = () => set(readVariant())
    listeners.add(fn)
    window.addEventListener('popstate', fn)
    return () => {
      listeners.delete(fn)
      window.removeEventListener('popstate', fn)
    }
  }, [])
  return variant
}

export function cycleVariant(delta: 1 | -1) {
  const index = VARIANTS.indexOf(readVariant())
  setVariant(VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length])
}
