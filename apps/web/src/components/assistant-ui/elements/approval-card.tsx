/**
 * Adapted from assistant-ui Elements (MIT, AgentbaseAI).
 * Upstream: assistant-ui/assistant-ui@4fffd182971380758dcda062ea076f7bc9257fee
 * See UPSTREAM.md for source paths and local adaptations; license in LICENSE.
 */

import { type ComponentProps, type ReactNode, useId } from 'react'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { Icon } from '../../ui/icon'
import { OverflowText } from '../../ui/overflowTitle'
import { field, mono, paper } from './surfaces'

export type ApprovalState = 'request' | 'running' | 'done' | 'denied'

const receiptText: Record<Exclude<ApprovalState, 'request'>, string> = {
  running: 'Approved, running',
  done: 'Finished',
  denied: 'Denied',
}

export function ApprovalCard({
  children,
  disabled,
  state,
  command,
  title,
  subtitle,
  description,
  details,
  variant = 'default',
  icon,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
  allowOnceLabel = 'Allow once',
  alwaysAllowLabel = 'Always allow',
  denyLabel = 'Deny',
  statusLabel,
  className,
  ...props
}: Omit<
  ComponentProps<'div'>,
  | 'children'
  | 'state'
  | 'command'
  | 'title'
  | 'subtitle'
  | 'description'
  | 'details'
  | 'variant'
  | 'icon'
  | 'onAllowOnce'
  | 'onAlwaysAllow'
  | 'onDeny'
  | 'allowOnceLabel'
  | 'alwaysAllowLabel'
  | 'denyLabel'
  | 'statusLabel'
> & {
  children?: ReactNode
  disabled?: boolean
  state: ApprovalState
  command?: string | undefined
  title: string
  subtitle: string
  description?: string | undefined
  details?: readonly { label: string; value: string }[] | undefined
  variant?: 'default' | 'destructive' | undefined
  icon?: ReactNode | undefined
  onAllowOnce?: (() => void) | undefined
  onAlwaysAllow?: (() => void) | undefined
  onDeny?: (() => void) | undefined
  allowOnceLabel?: string | undefined
  alwaysAllowLabel?: string | undefined
  denyLabel?: string | undefined
  statusLabel?: string | undefined
}) {
  const titleId = useId()
  const descriptionId = useId()

  return (
    <div
      {...props}
      role="group"
      data-variant={variant}
      data-slot="approval-card"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(paper, 'flex w-full max-w-xl flex-col gap-3.5 rounded-2xl p-4', className)}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl',
            variant === 'destructive'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-foreground/[0.05] text-muted-foreground',
          )}
        >
          {icon ?? <Icon name="terminal" size="sm" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <p id={titleId} className="text-sm font-medium">
            {title}
          </p>
          <OverflowText
            as="p"
            text={subtitle}
            className="line-clamp-2 break-words text-xs text-muted-foreground"
          />
        </div>
      </div>

      {description ? (
        <p id={descriptionId} className="text-muted-foreground text-body-sm">
          {description}
        </p>
      ) : null}

      {command ? (
        <div className={cn(field, 'text-foreground rounded-xl px-3.5 py-2.5 font-mono text-xs')}>
          {command}
        </div>
      ) : null}

      {details?.length ? (
        <dl className={cn(field, 'flex flex-col gap-2 rounded-xl px-3.5 py-2.5')}>
          {details.map((detail, index) => (
            <div
              key={`${detail.label}-${index}`}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 text-xs"
            >
              <dt className={cn(mono, 'text-muted-foreground')}>{detail.label}</dt>
              <dd className="text-foreground break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {children}
      <div className="flex min-h-8 flex-wrap items-center justify-end gap-2">
        {state === 'request' ? (
          <>
            {onDeny && (
              <Button variant="ghost" type="button" onClick={onDeny} disabled={disabled} size="sm">
                {denyLabel}
              </Button>
            )}
            {onAlwaysAllow && (
              <Button
                variant="ghost"
                type="button"
                onClick={onAlwaysAllow}
                disabled={disabled}
                size="sm"
              >
                {alwaysAllowLabel}
              </Button>
            )}
            {onAllowOnce && (
              <Button
                variant={variant}
                type="button"
                onClick={onAllowOnce}
                disabled={disabled}
                size="sm"
              >
                {allowOnceLabel}
              </Button>
            )}
          </>
        ) : (
          <div
            key={state}
            role="status"
            className="fade-in animate-in text-muted-foreground flex items-center gap-2 text-xs duration-300 motion-reduce:animate-none"
          >
            {state === 'running' ? (
              <>
                <Icon
                  name="loading"
                  size="xs"
                  className="text-muted-foreground animate-spin motion-reduce:animate-none"
                />
                {statusLabel ?? receiptText.running}
              </>
            ) : state === 'denied' ? (
              <>
                <Icon name="close" size="xs" className="text-muted-foreground" />
                {statusLabel ?? receiptText.denied}
              </>
            ) : (
              <>
                <Icon name="check" size="xs" className="text-primary" />
                {statusLabel ?? receiptText.done}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
