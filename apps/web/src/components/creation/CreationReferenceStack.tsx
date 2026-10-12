import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
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
  uploading = false,
}: {
  add: ReactNode
  previews: ReactNode[]
  count: number
  children: ReactNode
  status?: string
  failed?: boolean
  uploading?: boolean
}) {
  const { t } = useTranslation('composer')
  const [open, setOpen] = useState(false)
  const hoverOpened = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const panel = useRef<HTMLDivElement>(null)
  const cancelClose = () => clearTimeout(closeTimer.current)
  const leave = () => {
    cancelClose()
    if (!hoverOpened.current) return
    closeTimer.current = setTimeout(() => {
      if (
        panel.current?.contains(document.activeElement) ||
        document.querySelector('[role="menu"]')
      )
        return
      setOpen(false)
    }, 250)
  }
  useEffect(() => () => clearTimeout(closeTimer.current), [])
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
              aria-busy={uploading || undefined}
              onPointerEnter={(event) => {
                cancelClose()
                if (event.pointerType !== 'mouse' || open) return
                hoverOpened.current = true
                setOpen(true)
              }}
              onPointerLeave={leave}
              onClick={(event) => {
                // Clicking an already hover-open stack pins it instead of closing it.
                if (open && hoverOpened.current) event.preventDefault()
                hoverOpened.current = false
                cancelClose()
              }}
            >
              <span className="creation-stack-cards" aria-hidden="true">
                {previews.slice(-3).map((preview, index) => (
                  <span className="creation-stack-card" key={index}>
                    {preview}
                  </span>
                ))}
              </span>
              <span className="creation-stack-count">{failed ? '!' : count}</span>
              {uploading && (
                <span className="creation-stack-upload">
                  <Icon name="loading" className="animate-spin motion-reduce:animate-none" />
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            ref={panel}
            side="top"
            align="start"
            sideOffset={16}
            className="creation-reference-panel"
            aria-label={t('studio.references', { count })}
            onPointerEnter={cancelClose}
            onPointerLeave={leave}
            onOpenAutoFocus={(event) => {
              if (hoverOpened.current) event.preventDefault()
            }}
            onCloseAutoFocus={(event) => {
              if (hoverOpened.current) event.preventDefault()
            }}
            onInteractOutside={(event) => {
              // The existing per-image context menu portals outside this popover.
              if (event.target instanceof Element && event.target.closest('[role="menu"]'))
                event.preventDefault()
            }}
          >
            {status && (
              <div className="creation-reference-status" data-failed={failed || undefined}>
                {uploading && (
                  <Icon name="loading" className="animate-spin motion-reduce:animate-none" />
                )}
                {status}
              </div>
            )}
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
