import { Search } from 'lucide-react'
import type { InputHTMLAttributes } from 'react'
import { cn } from '../lib/utils'

export default function SearchField({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <label
      className={cn(
        'flex h-9 w-full max-w-[280px] items-center gap-2 rounded-lg border border-input px-3 text-muted-foreground transition-colors focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40',
        className,
      )}
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
      <input
        type="search"
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        {...props}
      />
    </label>
  )
}
