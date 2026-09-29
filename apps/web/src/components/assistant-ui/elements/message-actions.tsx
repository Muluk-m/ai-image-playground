/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */
import { CheckIcon, CopyIcon, PencilIcon, RefreshCwIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { ghostButton, iconSwap, iconSwapIn, iconSwapOut } from './surfaces'

export function MessageActions({
  copied,
  regenerating,
  onCopy,
  onEdit,
  onRegenerate,
  copyLabel,
  editLabel,
  regenerateLabel,
  children,
  className,
  ...props
}: ComponentProps<'div'> & {
  copied?: boolean
  regenerating?: boolean
  onCopy?: () => void
  onEdit?: () => void
  onRegenerate?: () => void
  copyLabel?: string
  editLabel?: string
  regenerateLabel?: string
  children?: ReactNode
}) {
  const iconButton = cn(ghostButton, 'size-8 p-0')
  return (
    <div
      data-slot="message-actions"
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      {...props}
    >
      {onCopy && (
        <Button
          type="button"
          variant="ghost"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={onCopy}
          className={cn(iconButton, 'grid place-items-center', copied && 'text-primary')}
        >
          <CopyIcon
            aria-hidden
            className={cn(iconSwap, 'size-3.5', copied ? iconSwapOut : iconSwapIn)}
          />
          <CheckIcon
            aria-hidden
            className={cn(iconSwap, 'size-3.5', copied ? iconSwapIn : iconSwapOut)}
          />
          {copied && (
            <span className="sr-only" role="status">
              {copyLabel}
            </span>
          )}
        </Button>
      )}
      {onEdit && (
        <Button type="button" variant="secondary" size="sm" className="rounded-xl" onClick={onEdit}>
          <PencilIcon aria-hidden />
          {editLabel}
        </Button>
      )}
      {onRegenerate && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="rounded-xl"
          disabled={regenerating}
          onClick={onRegenerate}
        >
          <RefreshCwIcon
            aria-hidden
            className={cn(regenerating && 'animate-spin motion-reduce:animate-none')}
          />
          {regenerateLabel}
        </Button>
      )}
      {children}
    </div>
  )
}
