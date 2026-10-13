import { type ReactNode, useId, useRef } from 'react'
import { useTranslation } from '../../i18n'
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
  const [expanded, setExpanded] = useReferenceDisplay()
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const collapse = useRef<HTMLButtonElement>(null)
  const expand = () => {
    setExpanded(true)
    requestAnimationFrame(() => collapse.current?.focus({ preventScroll: true }))
  }
  const close = () => {
    setExpanded(false)
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
  }
  return (
    <div
      className="creation-reference-stack"
      data-filled={count > 0}
      data-expanded={expanded}
      data-failed={failed || undefined}
    >
      {expanded ? (
        <section
          id={id}
          className="creation-reference-panel"
          aria-label={t('studio.references', { count })}
        >
          <div className="creation-reference-heading">
            <span>{t('studio.references', { count })}</span>
            <Button
              ref={collapse}
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('studio.collapseReferences')}
              title={t('studio.collapseReferences')}
              onClick={close}
            >
              <Icon name="chevronUp" />
            </Button>
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
              <Button
                type="button"
                variant="secondary"
                size="xs"
                className="creation-stack-expand"
                onClick={expand}
              >
                {t('studio.viewAllReferences')}
              </Button>
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
