// Adapted from assistant-ui Elements (MIT), retrieved 2026-09-16.
// https://r.assistant-ui.com/elements-composer.json
// Only the standalone composition used here is vendored; colors use our shared tokens.
import type { ComponentProps } from 'react'
import { PaperclipIcon } from '../../icons'

const cn = (...values: (string | false | undefined)[]) => values.filter(Boolean).join(' ')
const paper = 'border border-input bg-card text-card-foreground shadow-sm'
const ghostButton =
  'inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const inkButton = 'bg-primary text-primary-foreground transition-colors hover:bg-primary/90'

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
    <button
      type="button"
      aria-label="Add attachment"
      data-slot="composer-attach"
      disabled={!props.onClick}
      className={cn(
        ghostButton,
        'h-8 w-8 disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <PaperclipIcon className="h-4 w-4" />
    </button>
  )
}

export function ComposerSend({
  streaming,
  idle,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'children'> & {
  streaming: boolean
  idle: boolean
}) {
  return (
    <button
      type="button"
      aria-label={streaming ? 'Stop generating' : 'Send message'}
      data-slot="composer-send"
      className={cn(
        'relative grid h-8 w-8 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed',
        streaming || idle ? inkButton : 'bg-muted text-muted-foreground/50 transition-colors',
        className,
      )}
      {...props}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {streaming ? (
          <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />
        ) : (
          <path d="M12 19V5m-6 6 6-6 6 6" />
        )}
      </svg>
    </button>
  )
}
