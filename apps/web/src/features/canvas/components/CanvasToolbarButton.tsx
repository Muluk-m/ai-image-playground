import type { ReactNode } from 'react'
import { Hint } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { Button } from '../../../components/ui/button'
import { useStore } from '../../../store'

/**
 * 选中元素后浮出的工具条上的按钮。视频工具条与图片工具条共用一份。
 *
 * 做不了的动作不用原生 disabled：那样按钮拿不到焦点，键盘和读屏用户永远看不到原因。
 * 改成 aria-disabled，按下去说明为什么不行。
 */
export default function CanvasToolbarButton({
  icon,
  label,
  compact,
  destructive,
  disabled,
  reason,
  onClick,
}: {
  icon: ReactNode
  label: string
  /** 只留图标，说明文字移到悬停浮层里——动作一多，带文字的条会长到压住画布。 */
  compact?: boolean
  /** 破坏性动作在工具条上保持醒目的危险色。 */
  destructive?: boolean
  /** 正在进行中，暂时不可点。 */
  disabled?: boolean
  /** 做不了的原因；有它就是不可用。 */
  reason?: string
  /** 收到的是按钮本身，给需要贴着它开浮层的调用方量位置用。 */
  onClick: (button: HTMLButtonElement) => void
}) {
  const unavailable = reason !== undefined
  return (
    // compact 只留图标，说明放进提示；带文字的只在做不了时提示原因。
    <Hint tooltip={compact ? (reason ?? label) : reason}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`h-8 gap-1 text-xs ${compact ? 'w-8 px-0' : 'px-2'} ${destructive ? 'text-destructive hover:bg-destructive/10 hover:text-destructive' : ''} ${unavailable ? 'opacity-50' : ''}`}
        aria-label={label}
        aria-disabled={unavailable || undefined}
        // 做不了的原因读屏直接念；视觉上由提示框显示。
        aria-description={reason}
        disabled={disabled}
        onClick={(event) => {
          if (unavailable) useStore.getState().showToast(reason, 'error')
          else onClick(event.currentTarget)
        }}
      >
        {icon}
        {!compact && <span className="hidden sm:inline">{label}</span>}
      </Button>
    </Hint>
  )
}
