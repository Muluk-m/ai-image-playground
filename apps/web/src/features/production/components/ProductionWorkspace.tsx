import {
  type AgentToolArtifact,
  type ProductionContext,
  type ProductionGenerationView,
  productionClipVideo,
} from '@image-playground/shared'
import {
  Clapperboard,
  FileText,
  Film,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Sparkles,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import {
  activateProduction,
  type ProductionPane,
  setProductionPanelContext,
} from '../lib/productionContext'
import { useProductionDocument } from '../lib/useProductionDocument'
import '../production.css'
import { useProductionAssets } from '../lib/useProductionAssets'
import ProductionAssetPane, { type ProductionAssetTarget } from './ProductionAssetPane'
import ProductionAssetProposalPane from './ProductionAssetProposalPane'
import ProductionAssets from './ProductionAssets'
import ProductionClipPane from './ProductionClipPane'
import ProductionDocumentPane from './ProductionDocumentPane'
import ProductionExportPane from './ProductionExportPane'
import ProductionGenerationPane from './ProductionGenerationPane'
import ProductionGenerations from './ProductionGenerations'
import ProductionShotPane from './ProductionShotPane'

export default function ProductionWorkspace({
  conversationId,
  refreshKey,
  children,
  artifactPane,
  artifactContext,
  onCloseArtifact,
  onPreviewArtifact,
}: {
  conversationId: string | null
  refreshKey: string
  children: ReactNode
  artifactPane?: ReactNode
  artifactContext?: ProductionContext
  onCloseArtifact?: () => void
  onPreviewArtifact?: (generation: ProductionGenerationView, artifact: AgentToolArtifact) => void
}) {
  const { t } = useTranslation('production')
  const production = useProductionDocument(conversationId, refreshKey)
  const [generationTarget, setGenerationTarget] = useState<Exclude<ProductionPane, string> | null>(
    null,
  )
  const [showShots, setShowShots] = useState(false)
  const [showClips, setShowClips] = useState(false)
  const [showExport, setShowExport] = useState(false)
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
  useEffect(() => {
    setContentOpen(true)
    setGenerationTarget(null)
    setShowShots(false)
    setShowClips(false)
    setShowExport(false)
    setAssetTarget(null)
    setProposalId(null)
  }, [conversationId])
  const openAssets = () => {
    setAssetsOpen(true)
    setAssetsDrawerOpen(true)
  }
  const assetsTrigger = useRef<HTMLButtonElement>(null)
  const assetsPane = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!assetsDrawerOpen) return
    assetsPane.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => assetsTrigger.current?.focus()
  }, [assetsDrawerOpen])
  useEffect(
    () =>
      activateProduction(conversationId, (pane) => {
        onCloseArtifact?.()
        setAssetsDrawerOpen(false)
        setGenerationTarget(typeof pane === 'object' ? pane : null)
        setShowShots(pane === 'storyboard')
        setShowClips(false)
        setShowExport(false)
        setAssetTarget(null)
        setProposalId(null)
        setContentOpen(true)
      }),
    [conversationId],
  )
  const doc = production.document
  useEffect(() => {
    if (!artifactPane || !artifactContext || !doc || artifactContext.documentId !== doc.id) return
    setProductionPanelContext(doc.conversationId, { ...artifactContext, revision: doc.revision })
    return () => setProductionPanelContext(doc.conversationId, null)
  }, [artifactPane, artifactContext, doc?.id, doc?.revision, doc?.conversationId])
  return (
    <div
      className="production-workspace"
      data-assets-drawer={assetsDrawerOpen}
      data-content-open={Boolean(artifactPane || (doc && contentOpen))}
      data-assets-open={Boolean(doc && assetsOpen)}
    >
      {doc && (
        <button
          type="button"
          className="production-assets-trigger"
          ref={assetsTrigger}
          aria-expanded={assetsDrawerOpen}
          aria-label={t('openAssets')}
          onClick={openAssets}
        >
          <PanelLeftOpen size={17} />
        </button>
      )}
      {doc && (
        <aside
          className="production-assets"
          ref={assetsPane}
          hidden={!assetsOpen}
          aria-label={t('assets')}
          onKeyDown={(event) => {
            if (
              assetsDrawerOpen &&
              event.key === 'Escape' &&
              !event.defaultPrevented &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              event.stopPropagation()
              setAssetsDrawerOpen(false)
            }
          }}
        >
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
              onCloseArtifact?.()
              setContentOpen(true)
              setGenerationTarget(null)
              setShowShots(false)
              setShowClips(false)
              setShowExport(false)
              setAssetTarget(null)
              setProposalId(null)
              setAssetsDrawerOpen(false)
            }}
          >
            <FileText size={16} />
            <span>{doc.content.title || t('untitled')}</span>
          </button>
          <button
            type="button"
            className="production-document-link"
            aria-label={t('storyboard.title')}
            onClick={() => {
              onCloseArtifact?.()
              setGenerationTarget(null)
              setShowShots(true)
              setShowClips(false)
              setShowExport(false)
              setAssetTarget(null)
              setProposalId(null)
              setContentOpen(true)
              setAssetsDrawerOpen(false)
            }}
          >
            <Clapperboard size={16} />
            <span>{t('storyboard.title')}</span>
          </button>
          <button
            type="button"
            className="production-document-link"
            aria-label={t('clip.title')}
            onClick={() => {
              onCloseArtifact?.()
              setGenerationTarget(null)
              setShowClips(true)
              setShowExport(false)
              setShowShots(false)
              setAssetTarget(null)
              setProposalId(null)
              setContentOpen(true)
              setAssetsDrawerOpen(false)
            }}
          >
            <Film size={16} />
            <span>{t('clip.title')}</span>
          </button>
          <ProductionAssets
            document={doc}
            onSelect={(target) => {
              onCloseArtifact?.()
              setShowShots(false)
              setShowClips(false)
              setShowExport(false)
              setProposalId(null)
              setGenerationTarget(null)
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
                  onCloseArtifact?.()
                  setShowShots(false)
                  setShowClips(false)
                  setShowExport(false)
                  setGenerationTarget(null)
                  setProposalId(one.id)
                  setContentOpen(true)
                  setAssetsDrawerOpen(false)
                }}
              >
                <Sparkles size={14} />
                {t('asset.proposal')}
              </button>
            ))}
          <button
            type="button"
            className="production-document-link"
            aria-label={t('export.title')}
            onClick={() => {
              onCloseArtifact?.()
              setGenerationTarget(null)
              setShowExport(true)
              setContentOpen(true)
              setAssetsDrawerOpen(false)
              setProposalId(null)
              setAssetTarget(null)
            }}
          >
            <PackageOpen size={16} />
            <span>{t('export.title')}</span>
          </button>
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
              <button type="button" aria-label={t('openAssets')} onClick={openAssets}>
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
      {artifactPane ||
        (doc &&
          contentOpen &&
          (generationTarget ? (
            <ProductionGenerationPane
              key={`${doc.id}:${generationTarget.messageId}`}
              document={doc}
              target={generationTarget}
              onPreviewArtifact={onPreviewArtifact}
              onSaved={production.accept}
              onClose={() => {
                setGenerationTarget(null)
                setContentOpen(false)
              }}
            />
          ) : showExport ? (
            <ProductionExportPane
              key={doc.id}
              document={doc}
              onClose={() => setContentOpen(false)}
            />
          ) : proposal ? (
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
          ) : showClips ? (
            <ProductionClipPane
              renderGenerations={(clip, preparationBlocked) => (
                <ProductionGenerations
                  onPreviewArtifact={onPreviewArtifact}
                  key={clip.id}
                  conversationId={doc.conversationId}
                  document={doc}
                  target={{ kind: 'clip', id: clip.id }}
                  onSaved={production.accept}
                  refreshKey={refreshKey}
                  preparationBlocked={preparationBlocked}
                  adoptedArtifactId={clip.adopted?.artifactId}
                  initialDraft={{
                    prompt: clip.prompt,
                    model: clip.model,
                    video: productionClipVideo(clip),
                    references: clip.references,
                  }}
                />
              )}
              key={doc.id}
              document={doc}
              onClose={() => setContentOpen(false)}
              onSaved={production.accept}
            />
          ) : showShots ? (
            <ProductionShotPane
              key={doc.id}
              document={doc}
              onClose={() => setContentOpen(false)}
              onSaved={production.accept}
              refreshKey={refreshKey}
            />
          ) : assetTarget ? (
            <ProductionAssetPane
              onPreviewArtifact={onPreviewArtifact}
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
          )))}
    </div>
  )
}
