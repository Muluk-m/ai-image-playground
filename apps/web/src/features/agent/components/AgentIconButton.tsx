import type { LucideIcon } from 'lucide-react'
import { Button, type ButtonProps } from '../../../components/ui/button'
import { cn } from '../../../lib/utils'

export default function AgentIconButton({
  label,
  icon: Icon,
  busy = false,
  className,
  ...props
}: Omit<ButtonProps, 'children'> & {
  label: string
  icon: LucideIcon
  busy?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className={cn(
        'size-8 shrink-0 text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:ring-foreground',
        className,
      )}
      {...props}
    >
      <Icon
        aria-hidden
        className={cn('size-4', busy && 'animate-spin motion-reduce:animate-none')}
      />
      <span className="sr-only">{label}</span>
    </Button>
  )
}
