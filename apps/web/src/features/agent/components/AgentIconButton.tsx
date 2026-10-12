import {
  TooltipIconButton,
  type TooltipIconButtonProps,
} from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { Icon, type IconName } from '../../../components/ui/icon'
import { cn } from '../../../lib/utils'

/** Agent 卡片里的单动作按钮：图标加悬停提示，提示文字也是按钮的可访问名称。 */
export default function AgentIconButton({
  label,
  icon,
  busy = false,
  className,
  ...props
}: Omit<TooltipIconButtonProps, 'children' | 'tooltip'> & {
  label: string
  icon: IconName
  busy?: boolean
}) {
  return (
    <TooltipIconButton
      tooltip={label}
      className={cn('hover:bg-foreground/5 focus-visible:ring-foreground', className)}
      {...props}
    >
      <Icon name={icon} className={cn(busy && 'animate-spin motion-reduce:animate-none')} />
    </TooltipIconButton>
  )
}
