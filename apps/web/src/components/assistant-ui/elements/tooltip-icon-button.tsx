/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@3ad209c9b1692dcaa3fcfb4d12130b318ca566eb
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */
import { type ComponentPropsWithoutRef, forwardRef } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip'

export type TooltipIconButtonProps = ComponentPropsWithoutRef<typeof Button> & {
  /** 提示文字，同时作为按钮的可访问名称。 */
  tooltip: string
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/** 只有图标的按钮：悬停或聚焦显示提示，读屏读到同一段文字。 */
export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side = 'bottom', className, ...rest }, ref) => (
    <TooltipProvider delayDuration={300} skipDelayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
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
        </TooltipTrigger>
        <TooltipContent
          side={side}
          sideOffset={6}
          className="z-[1000] bg-foreground px-2.5 text-background motion-reduce:animate-none"
        >
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
)
TooltipIconButton.displayName = 'TooltipIconButton'
