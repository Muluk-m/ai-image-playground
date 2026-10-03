import type { ProductionAssetProposal } from '@image-playground/shared'
import { Sparkles, X } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import ProductionReferencePreview from './ProductionReferencePreview'
export default function ProductionAssetProposalPane({
  proposal,
  conversationId,
  busy,
  failed,
  onAdopt,
  onDiscard,
  onClose,
}: {
  proposal: ProductionAssetProposal
  conversationId: string
  busy: boolean
  failed: boolean
  onAdopt: () => void
  onDiscard: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('production')
  return (
    <section className="production-document" aria-label={t('asset.proposal')}>
      <header className="production-pane-header">
        <span>
          <Sparkles size={17} />
          {t('asset.proposal')}
        </span>
        <button type="button" aria-label={t('close')} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="production-document-tools">
        <button
          type="button"
          className="production-primary"
          disabled={busy || proposal.status !== 'pending'}
          onClick={onAdopt}
        >
          {t('asset.adopt')}
        </button>
        <button type="button" disabled={busy || proposal.status !== 'pending'} onClick={onDiscard}>
          {t('asset.dismiss')}
        </button>
        <span>{t('revision', { revision: proposal.baseRevision })}</span>
      </div>
      {failed && (
        <p className="production-error" role="alert">
          {t('asset.proposalFailed')}
        </p>
      )}
      <div className="production-document-scroll production-asset-form">
        {proposal.characters.map((character) => (
          <section key={character.id}>
            <h2>{character.name}</h2>
            <p className="production-prose">{character.description}</p>
            {character.looks.map((look) => (
              <div key={look.id}>
                <h3>{look.name}</h3>
                <p className="production-prose">{look.description}</p>
                {look.reference && (
                  <div className="production-reference-detail">
                    <ProductionReferencePreview
                      conversationId={conversationId}
                      reference={look.reference}
                      name={`${character.name} · ${look.name}`}
                    />
                  </div>
                )}
              </div>
            ))}
          </section>
        ))}
        {proposal.locations.map((location) => (
          <section key={location.id}>
            <h2>{location.name}</h2>
            <p className="production-prose">{location.description}</p>
            {location.reference && (
              <div className="production-reference-detail">
                <ProductionReferencePreview
                  conversationId={conversationId}
                  reference={location.reference}
                  name={location.name}
                />
              </div>
            )}
          </section>
        ))}
      </div>
    </section>
  )
}
