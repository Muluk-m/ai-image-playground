import type { ProductionContext, ProductionDocument } from '@image-playground/shared'
import { Quote } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { setProductionSelection } from '../lib/productionContext'

export default function ProductionQuotableText({
  document: doc,
  target,
  sceneId,
  text,
  className,
}: {
  document: ProductionDocument
  target: ProductionContext['target']
  sceneId?: string
  text: string
  className?: string
}) {
  const { t } = useTranslation('production')
  const ref = useRef<HTMLParagraphElement>(null)
  const [selection, setSelection] = useState<{
    context: ProductionContext
    x: number
    y: number
  } | null>(null)
  useEffect(() => {
    const update = () => {
      const el = ref.current
      const selection = window.getSelection()
      if (!el || !selection || selection.isCollapsed || !selection.rangeCount) {
        setSelection(null)
        return
      }
      const range = selection.getRangeAt(0)
      if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
        setSelection(null)
        return
      }
      const before = range.cloneRange()
      before.selectNodeContents(el)
      before.setEnd(range.startContainer, range.startOffset)
      const start = before.toString().length
      const quote = range.toString()
      if (!quote.trim() || text.slice(start, start + quote.length) !== quote) {
        setSelection(null)
        return
      }
      const rect =
        typeof range.getBoundingClientRect === 'function'
          ? range.getBoundingClientRect()
          : el.getBoundingClientRect()
      setSelection({
        context: {
          documentId: doc.id,
          revision: doc.revision,
          target,
          ...(sceneId ? { sceneId } : {}),
          quote: { start, end: start + quote.length, text: quote },
        },
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 140)),
        y: Math.max(8, rect.top - 40),
      })
    }
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        ref.current?.contains(window.getSelection()?.anchorNode ?? null)
      ) {
        setSelection(null)
        window.getSelection()?.removeAllRanges()
        ref.current.focus()
      }
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('keyup', update)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('keyup', update)
      document.removeEventListener('keydown', escape)
    }
  }, [doc.id, doc.revision, sceneId, target, text])
  return (
    <>
      <p ref={ref} tabIndex={-1} className={className} data-production-text={sceneId ?? target}>
        {text || t('emptySection')}
      </p>
      {selection && (
        <button
          type="button"
          className="production-quote-floating"
          style={{ left: selection.x, top: selection.y }}
          aria-label={t('quote')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setProductionSelection(doc.conversationId, selection.context)
            setSelection(null)
            window.getSelection()?.removeAllRanges()
            document.querySelector<HTMLElement>('.studio-agent-composer [contenteditable]')?.focus()
          }}
        >
          <Quote size={14} />
          {t('quote')}
        </button>
      )}
    </>
  )
}
