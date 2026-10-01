import type {
  AgentToolArtifact,
  ProductionDocument,
  ProductionGenerationView,
} from '@image-playground/shared'
import { X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from '../../../i18n'
import type { ProductionResponse } from '../lib/productionClient'
import { type ProductionPane, setProductionPanelContext } from '../lib/productionContext'
import ProductionGenerations from './ProductionGenerations'

export default function ProductionGenerationPane({
  document,
  target,
  onSaved,
  onClose,
  onPreviewArtifact,
}: {
  document: ProductionDocument
  target: Exclude<ProductionPane, string>
  onSaved: (next: ProductionResponse) => void
  onClose: () => void
  onPreviewArtifact?: (generation: ProductionGenerationView, artifact: AgentToolArtifact) => void
}) {
  const { t } = useTranslation('production')
  const character =
    target.target === 'look'
      ? document.content.characters?.find((one) =>
          one.looks.some((look) => look.id === target.targetId),
        )
      : undefined
  const entity =
    target.target === 'look'
      ? character?.looks.find((one) => one.id === target.targetId)
      : target.target === 'location'
        ? document.content.locations?.find((one) => one.id === target.targetId)
        : document.content.clips?.find((one) => one.id === target.targetId)
  const valid = document.id === target.documentId && Boolean(entity)
  useEffect(() => {
    if (!valid) return
    setProductionPanelContext(document.conversationId, {
      documentId: document.id,
      revision: document.revision,
      target: target.target,
      ...(target.target === 'look'
        ? { lookId: target.targetId }
        : target.target === 'location'
          ? { locationId: target.targetId }
          : { clipId: target.targetId }),
    })
    return () => setProductionPanelContext(document.conversationId, null)
  }, [
    valid,
    document.conversationId,
    document.id,
    document.revision,
    target.target,
    target.targetId,
  ])
  return (
    <section className="production-document" aria-label={t('generation.reviewDraft')}>
      <header className="production-pane-header">
        <strong>
          {valid
            ? [character?.name, entity?.name].filter(Boolean).join(' · ')
            : t('generation.reviewDraft')}
        </strong>
        <button type="button" aria-label={t('close')} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="production-document-scroll">
        {valid ? (
          <ProductionGenerations
            conversationId={document.conversationId}
            document={document}
            target={{ kind: target.target, id: target.targetId }}
            focusMessageId={target.messageId}
            onSaved={onSaved}
            onPreviewArtifact={onPreviewArtifact}
          />
        ) : (
          <p role="alert">{t('generation.draftUnavailable')}</p>
        )}
      </div>
    </section>
  )
}
