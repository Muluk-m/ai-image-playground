import type {
  AgentToolArtifact,
  ProductionDocument,
  ProductionGenerationView,
} from '@image-playground/shared'
import { Download, PackageOpen, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox } from '../../../components/ui/checkbox'
import { useTranslation } from '../../../i18n'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { downloadBlob } from '../../../lib/downloadImages'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import {
  buildProductionZip,
  freezeProductionExport,
  inspectProductionExport,
  PRODUCTION_EXPORT_MAX_BYTES,
  type ProductionExportInspection,
  productionExportResourceUrl,
} from '../lib/productionExport'

export default function ProductionExportPane({
  document,
  onClose,
}: {
  document: ProductionDocument
  onClose: () => void
}) {
  const { t } = useTranslation('production')
  const [candidates, setCandidates] = useState<AgentToolArtifact[]>([])
  const [extras, setExtras] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [plan, setPlan] = useState<ProductionExportInspection | null>(null)
  const [phase, setPhase] = useState<
    'idle' | 'inspecting' | 'packing' | 'complete' | 'partial' | 'cancelled'
  >('idle')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const controller = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const snapshot = useMemo(
    () =>
      freezeProductionExport(
        document,
        candidates.filter((one) => extras.has(one.artifactId)),
      ),
    [document, candidates, extras],
  )
  const busy = phase === 'inspecting' || phase === 'packing'
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      controller.current?.abort()
    }
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    void authenticatedBffFetch(
      `${bffBaseUrl()}/api/agent/conversations/${encodeURIComponent(document.conversationId)}/production/generations`,
      { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), cache: 'no-store' },
    )
      .then(async (response) => {
        if (!response.ok) return
        const body = (await response.json()) as { generations: ProductionGenerationView[] }
        if (!abort.signal.aborted) setCandidates(body.generations.flatMap((one) => one.artifacts))
      })
      .catch(() => {})
    return () => abort.abort()
  }, [document.conversationId, document.revision])
  const inspect = async () => {
    if (busy) return
    const abort = new AbortController()
    controller.current = abort
    setPhase('inspecting')
    setError(null)
    try {
      const fixed = {
        ...snapshot,
        resources: snapshot.resources.filter((one) => !selected || selected.has(one.key)),
      }
      const next = await inspectProductionExport(fixed, abort.signal)
      if (alive.current && !abort.signal.aborted) {
        setPlan(next)
        setPhase('idle')
      }
    } catch (failure) {
      if (alive.current) {
        setPhase(abort.signal.aborted ? 'cancelled' : 'idle')
        if (!abort.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'production_export_inspect_failed')
      }
    }
  }
  const pack = async (allowPartial: boolean, textOnly = false) => {
    if (busy || (!textOnly && !plan)) return
    const abort = new AbortController()
    controller.current = abort
    setPhase('packing')
    setError(null)
    setProgress({ done: 0, total: textOnly ? 0 : plan!.items.length })
    try {
      const actual = textOnly ? { snapshot: { ...snapshot, resources: [] }, items: [] } : plan!
      const result = await buildProductionZip(actual, {
        signal: abort.signal,
        allowPartial,
        onProgress: (done, total) => {
          if (alive.current) setProgress({ done, total })
        },
      })
      if (alive.current && !abort.signal.aborted) {
        downloadBlob(
          result.blob,
          `muvloom-production-v${actual.snapshot.document.revision}${result.missing.length ? '-partial' : ''}.zip`,
        )
        setPhase(result.missing.length ? 'partial' : 'complete')
      }
    } catch (failure) {
      if (alive.current) {
        setPhase(abort.signal.aborted ? 'cancelled' : 'idle')
        if (!abort.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'production_export_missing')
      }
    }
  }
  const items = plan?.items ?? []
  const total = items.reduce((sum, one) => sum + (one.bytes ?? 0), 0)
  const tooLarge = total > PRODUCTION_EXPORT_MAX_BYTES
  const unknown = items.some((one) => one.status === 'available' && one.bytes === null)
  const missing = items.filter((one) => one.status === 'missing')
  const change = () => {
    setPlan(null)
    setPhase('idle')
    setError(null)
  }
  return (
    <aside className="production-document" aria-label={t('export.title')}>
      <header className="production-pane-header">
        <span>
          <PackageOpen size={17} />
          {t('export.title')}
        </span>
        <button type="button" aria-label={t('close')} onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="production-document-scroll production-export">
        <h1>{document.content.title}</h1>
        <p>{t('export.intro')}</p>
        <div className="production-export-docs">
          <strong>{t('export.documents')}</strong>
          <span>
            script.md · characters-and-locations.md · storyboard.csv · manifest.json · README.md
          </span>
        </div>
        <fieldset disabled={busy}>
          <legend>{t('export.originals')}</legend>
          {snapshot.resources.map((one) => (
            <label key={one.key}>
              <Checkbox
                checked={!selected || selected.has(one.key)}
                onCheckedChange={(checked) => {
                  const next = new Set(selected ?? snapshot.resources.map((item) => item.key))
                  if (checked === true) next.add(one.key)
                  else next.delete(one.key)
                  setSelected(next)
                  change()
                }}
              />
              <span>{one.name}</span>
            </label>
          ))}
        </fieldset>
        {candidates.length > 0 && (
          <details>
            <summary>{t('export.extraCandidates')}</summary>
            <fieldset disabled={busy}>
              {candidates.map((one) => (
                <label key={one.artifactId}>
                  <Checkbox
                    checked={extras.has(one.artifactId)}
                    onCheckedChange={(checked) => {
                      const next = new Set(extras)
                      if (checked === true) next.add(one.artifactId)
                      else next.delete(one.artifactId)
                      setExtras(next)
                      setSelected(null)
                      change()
                    }}
                  />
                  <span>
                    {one.media === 'video' ? t('clip.title') : t('asset.reference')} ·{' '}
                    {one.artifactId}
                  </span>
                </label>
              ))}
            </fieldset>
          </details>
        )}
        {!plan && (
          <button
            type="button"
            className="production-export-primary"
            disabled={busy}
            onClick={() => void inspect()}
          >
            {t('export.inspect')}
          </button>
        )}
        {plan && (
          <section className="production-export-preview">
            <strong>
              {t('export.fixedRevision', { revision: plan.snapshot.document.revision })}
            </strong>
            <p>
              {t('export.size', {
                size: (total / 1024 / 1024).toFixed(1),
                max: PRODUCTION_EXPORT_MAX_BYTES / 1024 / 1024,
              })}
            </p>
            {items.map((one) => (
              <div key={one.key}>
                <span>{one.name}</span>
                <small>
                  {one.status === 'missing'
                    ? t('export.missing')
                    : one.bytes === null
                      ? t('export.unknown')
                      : `${(one.bytes / 1024 / 1024).toFixed(1)} MiB`}
                </small>
                {one.status === 'available' && (
                  <a
                    href={productionExportResourceUrl(plan.snapshot, one, true)}
                    download
                    rel="noreferrer"
                    target="_blank"
                  >
                    {t('export.single')}
                  </a>
                )}
              </div>
            ))}
            {tooLarge && <p role="alert">{t('export.tooLarge')}</p>}
            {unknown && <p role="alert">{t('export.unknownSize')}</p>}
            <button
              type="button"
              className="production-export-primary"
              disabled={busy || tooLarge || unknown || missing.length > 0}
              onClick={() => void pack(false)}
            >
              <Download size={15} />
              {t('export.download')}
            </button>
            {missing.length > 0 && (
              <button
                type="button"
                disabled={busy || tooLarge || unknown}
                onClick={() => void pack(true)}
              >
                {t('export.partial', { count: missing.length })}
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void inspect()}>
              {t('export.retry')}
            </button>
          </section>
        )}
        <button type="button" disabled={busy} onClick={() => void pack(false, true)}>
          {t('export.textOnly')}
        </button>
        {busy && (
          <div role="status">
            <p>
              {phase === 'inspecting' ? t('export.inspecting') : t('export.progress', progress)}
            </p>
            <button type="button" onClick={() => controller.current?.abort()}>
              {t('cancel')}
            </button>
          </div>
        )}
        {(phase === 'complete' || phase === 'partial' || phase === 'cancelled') && (
          <p role="status">{t(`export.${phase}`)}</p>
        )}
        {error && (
          <div role="alert">
            <p>
              {t(
                error === 'production_export_too_large'
                  ? 'export.tooLarge'
                  : error === 'production_export_unknown_size'
                    ? 'export.unknownSize'
                    : error === 'production_export_scope_changed'
                      ? 'export.scopeChanged'
                      : 'export.failed',
              )}
            </p>
            {plan && error === 'production_export_missing' && (
              <button type="button" disabled={busy} onClick={() => void pack(true)}>
                {t('export.acceptPartial')}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
