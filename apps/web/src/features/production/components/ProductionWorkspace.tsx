import { FileText, PanelLeftClose, PanelLeftOpen, PanelRightOpen, Sparkles } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { activateProduction } from '../lib/productionContext'
import { useProductionDocument } from '../lib/useProductionDocument'
import '../production.css'
import { useProductionAssets } from '../lib/useProductionAssets'
import ProductionAssetPane, { type ProductionAssetTarget } from './ProductionAssetPane'
import ProductionAssetProposalPane from './ProductionAssetProposalPane'
import ProductionAssets from './ProductionAssets'
import ProductionDocumentPane from './ProductionDocumentPane'

export default function ProductionWorkspace({
  conversationId,
  refreshKey,
  children,
}: {
  conversationId: string | null
  refreshKey: string
  children: ReactNode
}) {
  const { t } = useTranslation('production')
  const production = useProductionDocument(conversationId, refreshKey)
  const [proposalId, setProposalId] = useState<string | null>(null)
  const assets = useProductionAssets(
    conversationId,
    production.document?.revision ?? 0,
    refreshKey,
    production.accept,
  )
  const proposal = assets.proposals.find((one) => one.id === proposalId)
  const [assetTarget, setAssetTarget] = useState<ProductionAssetTarget | null>(null)
  const [contentOpen, setContentOpen] = useState(true)
  const [assetsOpen, setAssetsOpen] = useState(true)
  const [assetsDrawerOpen, setAssetsDrawerOpen] = useState(false)
  useEffect(
    () =>
      activateProduction(conversationId, () => {
        setAssetTarget(null)
        setProposalId(null)
        setContentOpen(true)
      }),
    [conversationId],
  )
  useEffect(() => {
    setContentOpen(true)
    setAssetTarget(null)
    setProposalId(null)
  }, [conversationId])
  const doc = production.document
  return (
    <div
      className="production-workspace"
      data-assets-drawer={assetsDrawerOpen}
      data-content-open={Boolean(doc && contentOpen)}
      data-assets-open={Boolean(doc && assetsOpen)}
    >
      {doc && (
        <button
          type="button"
          className="production-assets-trigger"
          aria-label={t('openAssets')}
          onClick={() => {
            setAssetsOpen(true)
            setAssetsDrawerOpen(true)
          }}
        >
          <PanelLeftOpen size={17} />
        </button>
      )}
      {doc && (
        <aside className="production-assets" hidden={!assetsOpen} aria-label={t('assets')}>
          <header>
            <strong>{t('assets')}</strong>
            <button
              type="button"
              aria-label={t('closeAssets')}
              onClick={() => {
                setAssetsOpen(false)
                setAssetsDrawerOpen(false)
              }}
            >
              <PanelLeftClose size={16} />
            </button>
          </header>
          <button
            type="button"
            className="production-document-link"
            aria-label={t('openScript')}
            onClick={() => {
              setContentOpen(true)
              setAssetTarget(null)
              setProposalId(null)
              setAssetsDrawerOpen(false)
            }}
          >
            <FileText size={16} />
            <span>{doc.content.title || t('untitled')}</span>
          </button>
          <ProductionAssets
            document={doc}
            onSelect={(target) => {
              setProposalId(null)
              setAssetTarget(target)
              setContentOpen(true)
              setAssetsDrawerOpen(false)
            }}
          />
          {assets.proposals
            .filter((one) => one.status === 'pending')
            .map((one) => (
              <button
                type="button"
                className="production-document-link"
                key={one.id}
                onClick={() => {
                  setProposalId(one.id)
                  setContentOpen(true)
                  setAssetsDrawerOpen(false)
                }}
              >
                <Sparkles size={14} />
                {t('asset.proposal')}
              </button>
            ))}
          <div className="production-assets-footer">
            <span>{t('continuous')}</span>
            <span>{t('sceneCount', { count: doc.content.scenes.length })}</span>
          </div>
        </aside>
      )}
      <section className="production-conversation" aria-label={t('assistant')}>
        <header className="production-chat-header">
          <span>
            <Sparkles size={17} />
            {t('assistant')}
          </span>
          <div>
            {doc && !assetsOpen && (
              <button
                type="button"
                aria-label={t('openAssets')}
                onClick={() => setAssetsOpen(true)}
              >
                <PanelLeftOpen size={17} />
              </button>
            )}
            {doc && !contentOpen && (
              <button
                type="button"
                aria-label={t('openScript')}
                onClick={() => setContentOpen(true)}
              >
                <PanelRightOpen size={17} />
              </button>
            )}
          </div>
        </header>
        {production.failed && (
          <div className="production-error" role="alert">
            {t('loadFailed')}
            <button type="button" onClick={production.reload}>
              {t('retry')}
            </button>
          </div>
        )}
        {children}
      </section>
      {doc &&
        contentOpen &&
        (proposal ? (
          <ProductionAssetProposalPane
            proposal={proposal}
            conversationId={doc.conversationId}
            busy={assets.busy}
            failed={assets.failed}
            onAdopt={() => void assets.act(proposal.id, 'adopt')}
            onDiscard={() => void assets.act(proposal.id, 'discard')}
            onClose={() => {
              setProposalId(null)
              setContentOpen(false)
            }}
          />
        ) : assetTarget ? (
          <ProductionAssetPane
            key={`${doc.id}:${assetTarget.kind}:${assetTarget.id ?? 'new'}`}
            document={doc}
            target={assetTarget}
            onSaved={production.accept}
            onClose={() => setContentOpen(false)}
          />
        ) : (
          <ProductionDocumentPane
            refreshKey={refreshKey}
            key={doc.id}
            document={doc}
            onClose={() => setContentOpen(false)}
            onSaved={production.accept}
          />
        ))}
    </div>
  )
}
