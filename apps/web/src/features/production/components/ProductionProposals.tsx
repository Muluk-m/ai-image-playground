import type { ProductionDocument, ProductionProposal } from '@image-playground/shared'
import { Check, GitCompareArrows, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import {
  adoptProductionProposal,
  discardProductionProposal,
  fetchProductionProposals,
  ProductionRequestError,
  type ProductionResponse,
} from '../lib/productionClient'

export default function ProductionProposals({
  document,
  refreshKey,
  onSaved,
  editing,
}: {
  document: ProductionDocument
  refreshKey: string
  onSaved: (next: ProductionResponse) => void
  editing: boolean
}) {
  const { t } = useTranslation('production')
  const [proposals, setProposals] = useState<readonly ProductionProposal[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<'proposalFailed' | 'proposalConflict' | null>(null)
  const [retry, setRetry] = useState(0)
  const operations = useRef(new Map<string, string>())
  useEffect(() => {
    const controller = new AbortController()
    void fetchProductionProposals(document.conversationId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setProposals(next.proposals ?? [])
          setError(null)
          if (next.document && next.document.revision > document.revision) onSaved(next)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('proposalFailed')
      })
    return () => controller.abort()
  }, [document.conversationId, document.revision, onSaved, refreshKey, retry])
  const apply = async (proposal: ProductionProposal, adopt: boolean) => {
    setBusy(proposal.id)
    setError(null)
    try {
      let operationId = operations.current.get(proposal.id)
      if (!operationId) {
        operationId = crypto.randomUUID()
        operations.current.set(proposal.id, operationId)
      }
      const next = adopt
        ? await adoptProductionProposal(
            document.conversationId,
            proposal.id,
            operationId,
            proposal.baseRevision,
          )
        : await discardProductionProposal(document.conversationId, proposal.id)
      setProposals(next.proposals ?? [])
      onSaved(next)
    } catch (cause) {
      setError(
        cause instanceof ProductionRequestError && cause.code === 'production_conflict'
          ? 'proposalConflict'
          : 'proposalFailed',
      )
    } finally {
      setBusy(null)
    }
  }
  const pending = proposals.filter((proposal) => proposal.status === 'pending')
  if (!pending.length && !error) return null
  return (
    <section className="production-proposals" aria-label={t('proposals')}>
      <header>
        <GitCompareArrows size={16} />
        <strong>{t('proposals')}</strong>
      </header>
      {error && (
        <p role="alert">
          {t(error)}{' '}
          <button type="button" onClick={() => setRetry((v) => v + 1)}>
            {t('retry')}
          </button>
        </p>
      )}
      {pending.map((proposal) => (
        <article key={proposal.id}>
          <div className="production-proposal-compare">
            <div>
              <span>{t('beforeEdit')}</span>
              <p>{proposal.before}</p>
            </div>
            <div>
              <span>{t('afterEdit')}</span>
              <p>{proposal.after}</p>
            </div>
          </div>
          {proposal.baseRevision !== document.revision && (
            <p role="status">{t('proposalConflict')}</p>
          )}
          <footer>
            <button
              type="button"
              className="production-primary"
              disabled={Boolean(busy) || editing || proposal.baseRevision !== document.revision}
              onClick={() => void apply(proposal, true)}
            >
              <Check size={14} />
              {t('adoptProposal')}
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void apply(proposal, false)}
            >
              <X size={14} />
              {t('discardProposal')}
            </button>
          </footer>
        </article>
      ))}
    </section>
  )
}
