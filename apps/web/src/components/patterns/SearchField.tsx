import type { InputHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'
import { Icon } from '../ui/icon'

export default function SearchField({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <label
      className={cn(
        'flex h-9 w-full max-w-[280px] items-center gap-2 rounded-md border border-input px-3 text-muted-foreground transition-colors focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40',
        className,
      )}
    >
      <Icon name="search" />
      <input
        type="search"
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        {...props}
      />
    </label>
  )
}
