import type { ProductionDocument } from '@image-playground/shared'
import { MapPin, Plus, UserRound } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import type { ProductionAssetTarget } from './ProductionAssetPane'
import ProductionReferencePreview from './ProductionReferencePreview'

export default function ProductionAssets({
  document,
  onSelect,
}: {
  document: ProductionDocument
  onSelect: (target: ProductionAssetTarget) => void
}) {
  const { t } = useTranslation('production')
  return (
    <div className="production-asset-sections">
      {(['character', 'location'] as const).map((kind) => {
        const items =
          kind === 'character'
            ? (document.content.characters ?? [])
            : (document.content.locations ?? [])
        return (
          <section key={kind}>
            <header>
              <span>
                {t(kind === 'character' ? 'asset.characters' : 'asset.locations')}{' '}
                <small>{items.length}</small>
              </span>
              <button
                type="button"
                aria-label={t(kind === 'character' ? 'asset.addCharacter' : 'asset.addLocation')}
                onClick={() => onSelect({ kind, id: null })}
              >
                <Plus size={15} />
              </button>
            </header>
            <div className="production-asset-grid">
              {items.map((item) => {
                const reference = 'looks' in item ? item.looks[0]?.reference : item.reference
                return (
                  <button
                    type="button"
                    className="production-asset-card"
                    key={item.id}
                    onClick={() => onSelect({ kind, id: item.id })}
                  >
                    <div className="production-asset-cover">
                      {reference ? (
                        <ProductionReferencePreview
                          conversationId={document.conversationId}
                          reference={reference}
                          name={item.name}
                        />
                      ) : kind === 'character' ? (
                        <UserRound size={24} />
                      ) : (
                        <MapPin size={24} />
                      )}
                    </div>
                    <strong>{item.name}</strong>
                    {'looks' in item && <small>{item.looks[0]?.name}</small>}
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
