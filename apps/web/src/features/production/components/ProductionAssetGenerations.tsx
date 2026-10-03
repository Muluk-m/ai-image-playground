import type {
  AgentToolArtifact,
  ProductionDocument,
  ProductionGenerationView,
} from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { getStoredChannels } from '../../../lib/channels/channelStore'
import type { ProductionResponse } from '../lib/productionClient'
import { setProductionPanelContext } from '../lib/productionContext'
import ProductionGenerations from './ProductionGenerations'

export default function ProductionAssetGenerations({
  document,
  target,
  unsaved,
  onSaved,
  onPreviewArtifact,
}: {
  onPreviewArtifact?: (generation: ProductionGenerationView, artifact: AgentToolArtifact) => void
  document: ProductionDocument
  target: { kind: 'look' | 'location'; id: string }
  unsaved: boolean
  onSaved: (next: ProductionResponse) => void
}) {
  const { t } = useTranslation('production')
  const [threeViews, setThreeViews] = useState(false)
  const character =
    target.kind === 'look'
      ? document.content.characters?.find((one) => one.looks.some((look) => look.id === target.id))
      : undefined
  const asset =
    target.kind === 'look'
      ? character?.looks.find((one) => one.id === target.id)
      : document.content.locations?.find((one) => one.id === target.id)
  useEffect(() => {
    if (!asset) return
    setProductionPanelContext(document.conversationId, {
      documentId: document.id,
      revision: document.revision,
      target: target.kind,
      ...(target.kind === 'look' ? { lookId: target.id } : { locationId: target.id }),
    })
    return () => setProductionPanelContext(document.conversationId, null)
  }, [document.conversationId, document.id, document.revision, target.kind, target.id, asset])
  if (!asset) return <p className="production-prose">{t('asset.saveBeforeGenerate')}</p>
  const name = character ? `${character.name} · ${asset.name}` : asset.name
  const description = [character?.description, asset.description].filter(Boolean).join('\n')
  const model =
    getStoredChannels()
      .flatMap((channel) => channel.models)
      .find((one) => (one.media ?? 'image') === 'image')?.id ?? ''
  return (
    <section className="production-asset-generation">
      {target.kind === 'look' && (
        <div className="production-look-tabs">
          <span>{t('asset.nextGeneration')}</span>
          <button type="button" aria-pressed={!threeViews} onClick={() => setThreeViews(false)}>
            {t('asset.reference')}
          </button>
          <button type="button" aria-pressed={threeViews} onClick={() => setThreeViews(true)}>
            {t('asset.threeViews')}
          </button>
        </div>
      )}
      <ProductionGenerations
        onPreviewArtifact={onPreviewArtifact}
        conversationId={document.conversationId}
        document={document}
        target={target}
        onSaved={onSaved}
        preparationBlocked={
          unsaved ? t('asset.saveBeforeGenerate') : !model ? t('generation.unavailable') : undefined
        }
        initialDraft={{
          prompt: threeViews
            ? t('asset.threeViewsPrompt', { name, description })
            : `${name}\n${description}`,
          model,
          references: asset.reference ? [{ reference: asset.reference }] : [],
        }}
      />
    </section>
  )
}
