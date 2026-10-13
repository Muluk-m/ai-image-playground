// Adapted from assistant-ui Elements (MIT), retrieved 2026-09-16.
// https://r.assistant-ui.com/elements-composer.json
// Only the standalone composition used here is vendored; colors use our shared tokens.
import type { ComponentProps } from 'react'
import { Button } from '../../ui/button'

import { Icon } from '../../ui/icon'

const cn = (...values: (string | false | undefined)[]) => values.filter(Boolean).join(' ')
const paper = 'border border-input bg-card text-card-foreground shadow-sm'

export function Composer({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="composer" className={cn('relative w-full', className)} {...props} />
}

export function ComposerBar({
  dragActive = false,
  className,
  ...props
}: ComponentProps<'div'> & { dragActive?: boolean }) {
  return (
    <div
      data-slot="composer-bar"
      data-drag-active={dragActive || undefined}
      className={cn(
        paper,
        'relative flex w-full flex-col gap-3 rounded-2xl p-3 transition-colors focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/10',
        dragActive && 'bg-accent',
        className,
      )}
      {...props}
    />
  )
}

export function ComposerAttachments({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="composer-attachments"
      className={cn('flex flex-wrap gap-2', className)}
      {...props}
    />
  )
}

export function ComposerToolbar({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="composer-toolbar"
      className={cn('flex items-center justify-between', className)}
      {...props}
    />
  )
}

export function ComposerActions({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="composer-actions"
      className={cn('flex items-center gap-1.5', className)}
      {...props}
    />
  )
}

export function ComposerAttachButton({
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'children'>) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label="Add attachment"
      data-slot="composer-attach"
      disabled={!props.onClick}
      className={cn('shrink-0 text-muted-foreground', className)}
      {...props}
    >
      <Icon name="attach" />
    </Button>
  )
}

export function ComposerSend({
  streaming,
  idle,
  busy = false,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'children'> & {
  streaming: boolean
  idle: boolean
  busy?: boolean
}) {
  return (
    <Button
      variant={streaming || idle ? 'default' : 'secondary'}
      size="icon-sm"
      type="button"
      aria-label={streaming ? 'Stop generating' : 'Send message'}
      data-slot="composer-send"
      aria-busy={busy || undefined}
      className={cn('relative shrink-0', className)}
      {...props}
    >
      {busy && !streaming ? (
        <Icon name="loading" className="animate-spin motion-reduce:animate-none" />
      ) : (
        <Icon name={streaming ? 'stop' : 'send'} filled={streaming} />
      )}
    </Button>
  )
}
