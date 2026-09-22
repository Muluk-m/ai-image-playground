// PROTOTYPE：底部浮动切换条，只在 dev 且 `?proto=looks` 时渲染。
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { cycleVariant, isProto, useVariant } from './proto'

const NAMES: Record<string, string> = {
  A: 'A · 网格 / 紧凑卡 / pill 单行',
  B: 'B · 列表 / 摊开卡 / 双行分层',
  C: 'C · 按用途分栏 / 抽屉卡 / 封面横滑',
}

export default function PrototypeSwitcher() {
  const variant = useVariant()
  useEffect(() => {
    if (!isProto()) return
    const onKey = (event: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (event.key === 'ArrowLeft') cycleVariant(-1)
      if (event.key === 'ArrowRight') cycleVariant(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!isProto()) return null
  return createPortal(
    <div className="fixed bottom-3 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-2 rounded-full border-2 border-fuchsia-500 bg-black px-3 py-1.5 font-mono text-xs text-white shadow-xl">
      <span className="rounded bg-fuchsia-500 px-1.5 py-0.5 text-[10px] font-bold">PROTOTYPE</span>
      <button type="button" onClick={() => cycleVariant(-1)} className="px-1 hover:text-fuchsia-300">
        ←
      </button>
      <span>{NAMES[variant]}</span>
      <button type="button" onClick={() => cycleVariant(1)} className="px-1 hover:text-fuchsia-300">
        →
      </button>
    </div>,
    document.body,
  )
}
