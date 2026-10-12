import type { ProductionContext } from '@image-playground/shared'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
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
          : selection.target === 'shot' || selection.target === 'shots'
            ? t('storyboard.title')
            : t('document')
  return (
    <div className="production-quote-chip" aria-label={t('quotedSource')}>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        className="h-auto"
        title={selection.quote?.text}
        aria-label={t('locateQuote')}
        onClick={() => locateProductionSelection(conversationId, selection)}
      >
        <Icon name="quote" />
        <span>
          <strong>
            {label} · V{selection.revision}
          </strong>
          <span>{selection.quote?.text ?? label}</span>
        </span>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        aria-label={t('removeQuote')}
        onClick={() => {
          setProductionSelection(conversationId, null)
          onRemove?.()
        }}
      >
        <Icon name="close" />
      </Button>
    </div>
  )
}
