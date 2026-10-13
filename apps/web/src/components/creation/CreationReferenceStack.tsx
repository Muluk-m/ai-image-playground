import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { Hint } from '../assistant-ui/elements/tooltip-icon-button'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { useReferenceDisplay } from './referenceDisplay'
import './creation.css'

export function CreationReferenceStack({
  add,
  previews,
  count,
  children,
  status,
  failed = false,
  uploading = false,
  onClear,
  disabled = false,
}: {
  add: ReactNode
  previews: ReactNode[]
  count: number
  children: ReactNode
  status?: string
  failed?: boolean
  uploading?: boolean
  onClear?: () => void
  disabled?: boolean
}) {
  const { t } = useTranslation('composer')
  const [expanded, setExpanded] = useReferenceDisplay()
  const [hovered, setHovered] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointerInside = useRef(false)
  const focusedElement = useRef<Element | null>(null)
  const visible = count > 0 && (expanded || hovered)
  const cancelLeave = () => clearTimeout(leaveTimer.current)
  useEffect(() => () => clearTimeout(leaveTimer.current), [])
  useEffect(() => {
    if (count === 0) setHovered(false)
  }, [count])
  const leave = () => {
    cancelLeave()
    leaveTimer.current = setTimeout(() => {
      if (pointerInside.current) return
      // React capture events include our portalled menus, without owning unrelated page menus.
      if (
        focusedElement.current?.isConnected &&
        document.activeElement === focusedElement.current
      ) {
        leave()
        return
      }
      setHovered(false)
    }, 200)
  }
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const collapse = useRef<HTMLButtonElement>(null)
  const expand = () => {
    cancelLeave()
    setHovered(false)
    setExpanded(true)
    requestAnimationFrame(() => collapse.current?.focus({ preventScroll: true }))
  }
  const close = () => {
    cancelLeave()
    setHovered(false)
    setExpanded(false)
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
  }
  const panel = (
    <section
      id={id}
      className="creation-reference-panel"
      aria-label={t('studio.references', { count })}
    >
      <div className="creation-reference-heading">
        <span>{t('studio.references', { count })}</span>
        <div className="flex items-center gap-2">
          {!expanded && count > 1 && (
            <Button type="button" variant="ghost" size="xs" onClick={expand}>
              <Icon name="fit" />
              {t('studio.viewAllReferences')}
            </Button>
          )}
          {onClear && (
            <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={onClear}>
              {t('studio.clearReferences')}
            </Button>
          )}
          <Hint tooltip={t('studio.collapseReferences')}>
            <Button
              ref={collapse}
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('studio.collapseReferences')}
              onClick={close}
            >
              <Icon name="minimize" />
            </Button>
          </Hint>
        </div>
      </div>
      {status && (
        <div
          className="creation-reference-status"
          aria-busy={uploading || undefined}
          data-failed={failed || undefined}
        >
          {status}
        </div>
      )}
      <div className="creation-reference-list">
        {children}
        <div className="creation-stack-add">{add}</div>
      </div>
    </section>
  )
  return (
    <Popover open={hovered && !expanded && count > 0} onOpenChange={setHovered}>
      <div
        className="creation-reference-stack"
        onPointerEnter={() => {
          pointerInside.current = true
          cancelLeave()
        }}
        onPointerLeave={() => {
          pointerInside.current = false
          leave()
        }}
        onFocusCapture={(event) => {
          focusedElement.current = event.target
        }}
        onBlurCapture={leave}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && hovered && !expanded) {
            event.stopPropagation()
            close()
          }
        }}
        data-filled={count > 0}
        data-expanded={expanded && count > 0}
        data-failed={failed || undefined}
      >
        {expanded && count > 0 ? (
          panel
        ) : (
          <>
            {count > 0 && (
              <PopoverAnchor asChild>
                <div className="creation-stack-entry">
                  <Button
                    ref={trigger}
                    type="button"
                    variant="ghost"
                    className="creation-stack-trigger"
                    aria-label={[t('studio.references', { count }), status]
                      .filter(Boolean)
                      .join('，')}
                    aria-expanded={visible}
                    aria-controls={id}
                    aria-busy={uploading || undefined}
                    onPointerEnter={(event) => {
                      if (event.pointerType === 'mouse') setHovered(true)
                    }}
                    onClick={expand}
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
                  {count > 1 && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      className="creation-stack-expand"
                      onClick={expand}
                    >
                      {t('studio.viewAllReferences')}
                    </Button>
                  )}
                </div>
              </PopoverAnchor>
            )}
            <div className="creation-stack-add">{add}</div>
          </>
        )}
        <PopoverContent
          side="top"
          sideOffset={12}
          collisionPadding={12}
          className="creation-reference-hover"
          onFocusOutside={(event) => {
            if (pointerInside.current) event.preventDefault()
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {panel}
        </PopoverContent>
        {status && (
          <span role={failed ? 'alert' : 'status'} className="sr-only">
            {status}
          </span>
        )}
      </div>
    </Popover>
  )
}
