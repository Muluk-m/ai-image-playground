import type { LucideIcon } from 'lucide-react'
import {
  TooltipIconButton,
  type TooltipIconButtonProps,
} from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { cn } from '../../../lib/utils'

/** Agent 卡片里的单动作按钮：图标加悬停提示，提示文字也是按钮的可访问名称。 */
export default function AgentIconButton({
  label,
  icon: Icon,
  busy = false,
  className,
  ...props
}: Omit<TooltipIconButtonProps, 'children' | 'tooltip'> & {
  label: string
  icon: LucideIcon
  busy?: boolean
}) {
  return (
    <TooltipIconButton
      tooltip={label}
      className={cn('hover:bg-foreground/5 focus-visible:ring-foreground', className)}
      {...props}
    >
      <Icon aria-hidden className={cn(busy && 'animate-spin motion-reduce:animate-none')} />
    </TooltipIconButton>
  )
}
