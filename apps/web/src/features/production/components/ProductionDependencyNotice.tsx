import type { ProductionDocument } from '@image-playground/shared'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import {
  fetchProduction,
  ProductionRequestError,
  type ProductionResponse,
  refreshProductionDependencies,
} from '../lib/productionClient'
export default function ProductionDependencyNotice({
  document,
  target,
  onSaved,
}: {
  document: ProductionDocument
  target: { kind: 'shot' | 'clip'; id: string }
  onSaved: (result: ProductionResponse) => void
}) {
  const { t } = useTranslation('production')
  const [result, setResult] = useState<ProductionResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'conflict' | 'saveFailed' | null>(null)
  const [kept, setKept] = useState(false)
  const operation = useRef(crypto.randomUUID())
  const identity = `${document.id}:${document.revision}:${target.kind}:${target.id}`
  const current = useRef(identity)
  current.current = identity
  useEffect(() => {
    const controller = new AbortController()
    setResult(null)
    setError(null)
    setKept(false)
    operation.current = crypto.randomUUID()
    void fetchProduction(document.conversationId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setResult(next)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('saveFailed')
      })
    return () => controller.abort()
  }, [document.conversationId, identity])
  const state =
    target.kind === 'shot'
      ? result?.shotDependencyStates?.find((item) => item.shotId === target.id)
      : result?.dependencyStates?.find((item) => item.clipId === target.id)
  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await refreshProductionDependencies(
        document.conversationId,
        target,
        document.revision,
        operation.current,
      )
      if (current.current === identity) {
        setResult(next)
        onSaved(next)
      }
    } catch (reason) {
      if (current.current === identity)
        setError(
          reason instanceof ProductionRequestError && reason.code === 'production_conflict'
            ? 'conflict'
            : 'saveFailed',
        )
    } finally {
      setBusy(false)
    }
  }
  if (!state?.outdated && !error) return null
  return (
    <aside className="production-dependency-notice" aria-label={t('dependencies.title')}>
      <div>
        <AlertTriangle size={16} />
        <strong>{t(kept ? 'dependencies.retained' : 'dependencies.title')}</strong>
      </div>
      {!kept && state?.outdated && (
        <>
          <p>{t('dependencies.hint')}</p>
          <ul>
            {state.changed.map((change) => (
              <li key={`${change.kind}:${change.id}`}>
                {change.name}
                {change.missing ? ` · ${t('dependencies.missing')}` : ''}
              </li>
            ))}
          </ul>
          <div className="production-dependency-actions">
            <button
              type="button"
              disabled={busy}
              data-action="refresh-production-dependencies"
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} />
              {t(busy ? 'saving' : 'dependencies.refresh')}
            </button>
            <button type="button" disabled={busy} onClick={() => setKept(true)}>
              {t('dependencies.keep')}
            </button>
          </div>
        </>
      )}
      {kept && (
        <button type="button" onClick={() => setKept(false)}>
          {t('dependencies.show')}
        </button>
      )}
      {error && <p role="alert">{t(error)}</p>}
    </aside>
  )
}
