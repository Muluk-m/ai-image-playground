/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */

import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../../lib/utils'
import { Icon } from '../../ui/icon'
import { iconSwap, iconSwapIn, iconSwapOut } from './surfaces'
import { TooltipIconButton } from './tooltip-icon-button'

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
  return (
    <div
      data-slot="message-actions"
      className={cn('flex flex-wrap items-center gap-1', className)}
      {...props}
    >
      {onCopy && (
        <TooltipIconButton
          tooltip={copyLabel ?? ''}
          onClick={onCopy}
          className={cn('grid place-items-center', copied && 'text-foreground')}
        >
          <Icon name="copy" className={cn(iconSwap, copied ? iconSwapOut : iconSwapIn)} />
          <Icon name="check" className={cn(iconSwap, copied ? iconSwapIn : iconSwapOut)} />
          {copied && (
            <span className="sr-only" role="status">
              {copyLabel}
            </span>
          )}
        </TooltipIconButton>
      )}
      {onEdit && (
        <TooltipIconButton tooltip={editLabel ?? ''} onClick={onEdit}>
          <Icon name="edit" />
        </TooltipIconButton>
      )}
      {onRegenerate && (
        <TooltipIconButton
          tooltip={regenerateLabel ?? ''}
          disabled={regenerating}
          onClick={onRegenerate}
        >
          <Icon
            name="refresh"
            className={cn(regenerating && 'animate-spin motion-reduce:animate-none')}
          />
        </TooltipIconButton>
      )}
      {children}
    </div>
  )
}
