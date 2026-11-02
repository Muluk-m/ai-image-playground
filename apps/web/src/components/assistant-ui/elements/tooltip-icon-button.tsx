/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@3ad209c9b1692dcaa3fcfb4d12130b318ca566eb
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */
import { type ComponentPropsWithoutRef, forwardRef } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { Hint, type Side } from '../../ui/tooltip'

export { closeTooltips, Hint } from '../../ui/tooltip'

export type TooltipIconButtonProps = ComponentPropsWithoutRef<typeof Button> & {
  /** 动作名称，同时作为按钮的可访问名称；常见图标不重复显示提示。 */
  tooltip: string
  side?: Side
}

/** 只有图标的按钮：始终保留读屏名称，仅为不直观的图标显示动作提示。 */
export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side = 'bottom', className, ...rest }, ref) => (
    <Hint tooltip={rest['aria-description'] ?? tooltip} side={side}>
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
