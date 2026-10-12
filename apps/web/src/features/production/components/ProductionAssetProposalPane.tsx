import type { ProductionAssetProposal } from '@image-playground/shared'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
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
          <Icon name="generate" />
          {t('asset.proposal')}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={t('close')}
          onClick={onClose}
        >
          <Icon name="close" />
        </Button>
      </header>
      <div className="production-document-tools">
        <Button
          variant="default"
          size="sm"
          type="button"
          disabled={busy || proposal.status !== 'pending'}
          onClick={onAdopt}
        >
          {t('asset.adopt')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={busy || proposal.status !== 'pending'}
          onClick={onDiscard}
        >
          {t('asset.dismiss')}
        </Button>
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
