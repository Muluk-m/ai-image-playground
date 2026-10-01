import type { ProductionContext } from '@image-playground/shared'
import { Quote, X } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import {
  locateProductionSelection,
  setProductionSelection,
  useProductionSelection,
} from '../lib/productionContext'

export default function ProductionQuoteChip({
  conversationId,
  frozenContext,
  onRemove,
}: {
  conversationId: string | null
  frozenContext?: ProductionContext
  onRemove?: () => void
}) {
  const { t } = useTranslation('production')
  const selected = useProductionSelection(conversationId)
  const selection = frozenContext ?? selected
  if (!selection || !conversationId) return null
  const label =
    selection.target === 'setting'
      ? t('setting')
      : selection.target === 'outline'
        ? t('outline')
        : selection.target === 'scene'
          ? t('sceneBody')
          : t('document')
  return (
    <div className="production-quote-chip" aria-label={t('quotedSource')}>
      <button
        type="button"
        title={selection.quote?.text}
        aria-label={t('locateQuote')}
        onClick={() => locateProductionSelection(conversationId, selection)}
      >
        <Quote size={14} />
        <span>
          <strong>
            {label} · V{selection.revision}
          </strong>
          <span>{selection.quote?.text ?? t('document')}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label={t('removeQuote')}
        onClick={() => {
          setProductionSelection(conversationId, null)
          onRemove?.()
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}
