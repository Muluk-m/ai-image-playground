import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { isInFloatingLayer } from '../../lib/dropdown'
import { Hint } from '../assistant-ui/elements/tooltip-icon-button'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
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
  const container = useRef<HTMLDivElement>(null)
  const visible = count > 0 && (expanded || hovered)
  const cancelLeave = () => clearTimeout(leaveTimer.current)
  useEffect(() => () => clearTimeout(leaveTimer.current), [])
  useEffect(() => {
    if (count === 0) setHovered(false)
  }, [count])
  const leave = () => {
    cancelLeave()
    leaveTimer.current = setTimeout(() => {
      // Menus are portalled outside this subtree; keep their owner mounted until they close.
      if (document.querySelector('[role="menu"]') || isInFloatingLayer(document.activeElement)) {
        leave()
        return
      }
      if (!container.current?.contains(document.activeElement)) setHovered(false)
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
  return (
    <div
      ref={container}
      className="creation-reference-stack"
      onPointerEnter={cancelLeave}
      onPointerLeave={leave}
      onBlur={leave}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && hovered && !expanded) {
          event.stopPropagation()
          close()
        }
      }}
      data-filled={count > 0}
      data-expanded={visible}
      data-failed={failed || undefined}
    >
      {visible ? (
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
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={disabled}
                  onClick={onClear}
                >
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
      ) : (
        <>
          {count > 0 && (
            <div className="creation-stack-entry">
              <Button
                ref={trigger}
                type="button"
                variant="ghost"
                className="creation-stack-trigger"
                aria-label={[t('studio.references', { count }), status].filter(Boolean).join('，')}
                aria-expanded={false}
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
          )}
          <div className="creation-stack-add">{add}</div>
        </>
      )}
      {status && (
        <span role={failed ? 'alert' : 'status'} className="sr-only">
          {status}
        </span>
      )}
    </div>
  )
}
