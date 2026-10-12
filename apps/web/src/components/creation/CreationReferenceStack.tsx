import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import './creation.css'

/** The preview occupies one slot regardless of count; editing lives in the popover. */
export function CreationReferenceStack({
  add,
  previews,
  count,
  children,
  status,
  failed = false,
}: {
  add: ReactNode
  previews: ReactNode[]
  count: number
  children: ReactNode
  status?: string
  failed?: boolean
}) {
  const { t } = useTranslation('composer')
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (count === 0) setOpen(false)
  }, [count])
  return (
    <div
      className="creation-reference-stack"
      data-filled={count > 0}
      data-failed={failed || undefined}
    >
      {count > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className="creation-stack-trigger"
              aria-label={[t('studio.references', { count }), status].filter(Boolean).join('，')}
              title={status}
            >
              <span className="creation-stack-cards" aria-hidden="true">
                {previews.slice(-3).map((preview, index) => (
                  <span className="creation-stack-card" key={index}>
                    {preview}
                  </span>
                ))}
              </span>
              <span className="creation-stack-count">{failed ? '!' : count}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={16}
            className="creation-reference-panel"
            aria-label={t('studio.references', { count })}
            onInteractOutside={(event) => {
              // The existing per-image context menu portals outside this popover.
              if (event.target instanceof Element && event.target.closest('[role="menu"]'))
                event.preventDefault()
            }}
          >
            <div className="creation-reference-list">{children}</div>
          </PopoverContent>
        </Popover>
      )}
      {status && (
        <span role={failed ? 'alert' : 'status'} className="sr-only">
          {status}
        </span>
      )}
      <div className="creation-stack-add">{add}</div>
    </div>
  )
}
