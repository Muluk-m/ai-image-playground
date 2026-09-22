import type { ReactNode } from 'react'
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
  disabled,
  reason,
  onClick,
}: {
  icon: ReactNode
  label: string
  /** 正在进行中，暂时不可点。 */
  disabled?: boolean
  /** 做不了的原因；有它就是不可用。 */
  reason?: string
  /** 收到的是按钮本身，给需要贴着它开浮层的调用方量位置用。 */
  onClick: (button: HTMLButtonElement) => void
}) {
  const unavailable = reason !== undefined
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`h-8 gap-1 px-2 text-xs ${unavailable ? 'opacity-50' : ''}`}
      aria-label={label}
      aria-disabled={unavailable || undefined}
      title={reason ?? label}
      disabled={disabled}
      onClick={(event) => {
        if (unavailable) useStore.getState().showToast(reason, 'error')
        else onClick(event.currentTarget)
      }}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  )
}
