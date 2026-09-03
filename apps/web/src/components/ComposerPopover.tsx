import type { ReactNode, Ref } from 'react'

interface ComposerPopoverProps {
  heading: ReactNode
  /** 相对输入框左边缘的像素偏移，让弹层跟随光标或 chip */
  offsetLeft: number
  children: ReactNode
  ref?: Ref<HTMLDivElement>
}

/** composer 输入框上方的定位型小弹层外壳（@ 候选、槽位取值共用）。 */
export default function ComposerPopover({
  heading,
  offsetLeft,
  children,
  ref,
}: ComposerPopoverProps) {
  return (
    <div
      ref={ref}
      style={{ left: `${offsetLeft}px` }}
      className="absolute bottom-full z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-gray-200/70 bg-white/95 p-1.5 shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
    >
      <div className="px-2 pb-1 pt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{heading}</div>
      {children}
    </div>
  )
}
