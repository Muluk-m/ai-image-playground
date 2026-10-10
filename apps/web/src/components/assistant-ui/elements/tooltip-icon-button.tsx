/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@3ad209c9b1692dcaa3fcfb4d12130b318ca566eb
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */
import { type ComponentPropsWithoutRef, forwardRef, type ReactElement, type ReactNode } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip'

type Side = 'top' | 'bottom' | 'left' | 'right'

/**
 * 收起所有打开着的提示。Radix 的提示在别的提示打开时会听 `tooltip.open` 自行关闭，
 * 模态浮层打开时借同一个事件收起背景里的提示，免得它浮在 backdrop 上面。
 */
export function closeTooltips(): void {
  document.dispatchEvent(new CustomEvent('tooltip.open'))
}

/**
 * 给任意一个元素挂悬停/聚焦提示。`tooltip` 为空时不显示；
 * `open` / `onOpenChange` 传入时由调用方控制显隐（比如触屏点一下也要能看到的说明）。
 * 子元素必须能接 ref 和事件（原生元素或 forwardRef 组件）；禁用的按钮收不到指针事件，要包一层再挂。
 */
export function Hint({
  tooltip,
  side = 'top',
  open,
  onOpenChange,
  className,
  children,
}: {
  tooltip?: ReactNode
  side?: Side
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  children: ReactElement
}) {
  // 没有提示时也保持同一层结构：提示文字随状态出现或消失时，子元素不会被卸载重挂。
  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={200}>
      <Tooltip open={open} onOpenChange={onOpenChange}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        {tooltip ? (
          <TooltipContent
            side={side}
            sideOffset={6}
            className={cn(
              'z-[1000] max-w-xs bg-foreground px-2.5 text-background motion-reduce:animate-none',
              className,
            )}
          >
            {tooltip}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  )
}

export type TooltipIconButtonProps = ComponentPropsWithoutRef<typeof Button> & {
  /** 提示文字，同时作为按钮的可访问名称。 */
  tooltip: string
  side?: Side
}

/** 只有图标的按钮：悬停或聚焦显示提示，读屏读到同一段文字。 */
export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side = 'bottom', className, ...rest }, ref) => (
    <Hint tooltip={tooltip} side={side}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        {...rest}
        aria-label={rest['aria-label'] ?? tooltip}
        className={cn(
          'size-8 shrink-0 rounded-lg p-0 text-muted-foreground hover:text-foreground active:scale-95 [&_svg]:size-4',
          className,
        )}
        ref={ref}
      >
        {children}
        <span className="sr-only">{tooltip}</span>
      </Button>
    </Hint>
  ),
)
TooltipIconButton.displayName = 'TooltipIconButton'
