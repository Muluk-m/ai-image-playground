import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import type { ReactElement, ReactNode } from 'react'
import * as React from 'react'

import { cn } from '../../lib/utils'
import { iconActionTooltip } from './icon-action-tooltip'

const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }

export type Side = 'top' | 'bottom' | 'left' | 'right'

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
  sideOffset = 6,
  disableHoverableContent,
  open,
  onOpenChange,
  className,
  children,
}: {
  tooltip?: ReactNode
  side?: Side
  sideOffset?: number
  disableHoverableContent?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  children: ReactElement
}) {
  const content = iconActionTooltip(
    tooltip,
    children.props as {
      children?: ReactNode
      'aria-label'?: string
      'aria-description'?: string
    },
  )
  // 没有提示时也保持同一层结构：提示文字随状态出现或消失时，子元素不会被卸载重挂。
  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={200}>
      <Tooltip
        open={open}
        onOpenChange={onOpenChange}
        disableHoverableContent={disableHoverableContent}
      >
        <TooltipTrigger asChild data-tooltip-trigger>
          {children}
        </TooltipTrigger>
        {content ? (
          <TooltipContent
            side={side}
            sideOffset={sideOffset}
            className={cn(
              'z-[1000] max-w-xs bg-foreground px-2.5 text-background motion-reduce:animate-none',
              className,
            )}
          >
            {content}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  )
}
