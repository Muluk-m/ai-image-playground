import { type PointerEvent, useRef, useState } from 'react'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'

const clamp = (value: number) => Math.min(100, Math.max(0, value))

/** 同一格里的前后对比：左边原图、右边处理后，拖动中线或用方向键调分界。 */
export default function CompareView({
  before,
  after,
  onExit,
}: {
  before: string
  after: string
  onExit: () => void
}) {
  const { t } = useTranslation('toolbox')
  const [split, setSplit] = useState(50)
  const box = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const follow = (event: PointerEvent) => {
    const rect = box.current?.getBoundingClientRect()
    if (rect?.width) setSplit(clamp(((event.clientX - rect.left) / rect.width) * 100))
  }
  return (
    <div
      ref={box}
      className="absolute inset-0 cursor-ew-resize touch-none select-none"
      onPointerDown={(event) => {
        dragging.current = true
        event.currentTarget.setPointerCapture?.(event.pointerId)
        follow(event)
      }}
      onPointerMove={(event) => dragging.current && follow(event)}
      onPointerUp={() => {
        dragging.current = false
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
    >
      {/* 两侧各裁到自己那半：原图的留白或透明处不能透出处理后的图。 */}
      <img
        src={after}
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
        style={{ clipPath: `inset(0 0 0 ${split}%)` }}
      />
      <img
        src={before}
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
        style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow"
        style={{ left: `${split}%` }}
      />
      <div
        role="slider"
        tabIndex={0}
        aria-label={t('compare.slider')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(split)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 2
          if (event.key === 'ArrowLeft') setSplit((value) => clamp(value - step))
          else if (event.key === 'ArrowRight') setSplit((value) => clamp(value + step))
          else if (event.key === 'Escape') onExit()
          else return
          event.preventDefault()
        }}
        className="absolute top-1/2 grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-black shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ left: `${split}%` }}
      >
        <Icon name="compare" size="xs" />
      </div>
      <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-label-sm text-white">
        {t('compare.before')}
      </span>
      <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-label-sm text-white">
        {t('compare.after')}
      </span>
    </div>
  )
}
