import type { ComponentProps } from 'react'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'

export default function SearchField({
  className,
  onClear,
  clearLabel,
  onKeyDown,
  value,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & {
  onClear?: () => void
  clearLabel?: string
}) {
  const { t } = useTranslation('common')
  const hasValue = typeof value === 'string' ? value.length > 0 : Boolean(value)
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
        value={value}
        onKeyDown={(event) => {
          if (
            event.key === 'Escape' &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229 &&
            onClear &&
            hasValue
          ) {
            event.preventDefault()
            event.stopPropagation()
            onClear()
            return
          }
          onKeyDown?.(event)
        }}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        {...props}
      />
      {onClear && hasValue && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          autoTooltip={false}
          aria-label={clearLabel ?? t('action.clear')}
          className="-mr-1.5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onClear}
        >
          <Icon name="close" />
        </Button>
      )}
    </label>
  )
}
