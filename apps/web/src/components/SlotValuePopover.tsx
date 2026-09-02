import { useEffect, useRef, useState } from 'react'
import { parseSlotValueLines } from '../lib/promptSlots'

interface SlotValuePopoverProps {
  name: string
  values: string[]
  /** 相对输入框左边缘的像素偏移，让弹层贴住 chip */
  offsetLeft: number
  onChange: (values: string[]) => void
  onClose: () => void
}

export default function SlotValuePopover({
  name,
  values,
  offsetLeft,
  onChange,
  onClose,
}: SlotValuePopoverProps) {
  const [text, setText] = useState(() => values.join('\n'))
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || ref.current?.contains(target)) return
      // 命中另一个 chip 时交给它自己切换，别在这里先关掉
      if (target instanceof HTMLElement && target.closest('.slot-tag')) return
      onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{ left: `${offsetLeft}px` }}
      className="absolute bottom-full z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-gray-200/70 bg-white/95 p-1.5 shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
    >
      <div className="px-2 pb-1 pt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
        {`槽位 {${name}}`}
      </div>
      <textarea
        autoFocus
        value={text}
        rows={4}
        placeholder="一行一个值"
        aria-label={`槽位 {${name}} 的值`}
        onChange={(e) => {
          setText(e.target.value)
          onChange(parseSlotValueLines(e.target.value))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        className="custom-scrollbar w-full resize-none rounded-xl bg-gray-50 px-2 py-1.5 text-xs leading-relaxed text-gray-700 outline-none placeholder:text-gray-400 focus:bg-gray-100 dark:bg-white/[0.04] dark:text-gray-200 dark:placeholder:text-gray-500 dark:focus:bg-white/[0.07]"
      />
    </div>
  )
}
