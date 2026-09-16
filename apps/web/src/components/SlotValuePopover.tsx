import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n'
import { parseSlotValueLines } from '../lib/promptSlots'
import ComposerPopover from './ComposerPopover'

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
  const { t } = useTranslation('composer')
  const [text, setText] = useState(() => values.join('\n'))
  const ref = useRef<HTMLDivElement>(null)
  const slot = `{${name}}`

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
    <ComposerPopover ref={ref} heading={t('slot.heading', { slot })} offsetLeft={offsetLeft}>
      <textarea
        autoFocus
        value={text}
        rows={4}
        placeholder={t('slot.placeholder')}
        aria-label={t('slot.valuesLabel', { slot })}
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
    </ComposerPopover>
  )
}
