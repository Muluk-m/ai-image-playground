import type { AgentBatchEstimate, AgentBatchItem, AgentBatchPage } from '@image-playground/shared'
import { Fragment, useEffect, useState } from 'react'
import Credits from '../../../components/Credits'
import MediaImage from '../../../components/MediaImage'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { CARD, CARD_NOTE } from '../agentStyles'
import {
  AgentRequestError,
  cancelBatchPlan,
  fetchBatchPlan,
  updateBatchPlan,
} from '../lib/agentClient'

function Estimate({ value }: { value: AgentBatchEstimate }) {
  const { t } = useTranslation('agent')
  return value.status === 'available' ? (
    <Credits credits={value.estimatedChargeCredits} />
  ) : (
    <span>{t('batch.unavailable')}</span>
  )
}

/** Provider parameter names stay in the protocol; the review card uses user-facing labels. */
function OutputParameters({ params }: { params: AgentBatchItem['params'] }) {
  const { t } = useTranslation('agent')
  const level = (value: string) => {
    switch (value) {
      case 'auto':
        return t('batch.valueAuto')
      case 'high':
        return t('batch.valueHigh')
      case 'medium':
        return t('batch.valueMedium')
      case 'low':
        return t('batch.valueLow')
      case 'minimal':
        return t('batch.valueMinimal')
      case 'standard':
        return t('batch.valueStandard')
      case 'hd':
        return t('batch.valueHd')
      default:
        return value
    }
  }
  const rows: readonly (readonly [string, string | undefined])[] = [
    [t('batch.model'), params.model],
    [t('batch.quality'), params.quality ? level(params.quality) : undefined],
    [t('batch.aspectRatio'), params.gemini_aspect_ratio],
    [
      t('batch.thinking'),
      params.gemini_thinking_level ? level(params.gemini_thinking_level) : undefined,
    ],
    [t('batch.outputFormat'), params.output_format?.toUpperCase()],
    [
      t('batch.compression'),
      params.output_compression === undefined ? undefined : String(params.output_compression),
    ],
  ]
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {rows
        .filter(([, value]) => value !== undefined)
        .map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words text-right">{value}</dd>
          </Fragment>
        ))}
    </dl>
  )
}

export default function AgentBatchPlanCard({ batchId, domId }: { batchId: string; domId: string }) {
  const { t } = useTranslation(['agent', 'errors'])
  const [page, setPage] = useState<AgentBatchPage | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'fallback' | 'batch_version_conflict' | null>(null)
  useEffect(() => {
    let active = true
    void fetchBatchPlan(batchId)
      .then((result) => {
        if (active) setPage(result)
      })
      .catch(() => {
        if (active) setError('fallback')
      })
    return () => {
      active = false
    }
  }, [batchId])
  const apply = async (request: () => Promise<AgentBatchPage>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await request()
      setPage(result)
      setDirty(false)
    } catch (cause) {
      setError(
        cause instanceof AgentRequestError && cause.code === 'batch_version_conflict'
          ? 'batch_version_conflict'
          : 'fallback',
      )
    } finally {
      setBusy(false)
    }
  }
  const refresh = () => apply(() => fetchBatchPlan(batchId))
  if (!page)
    return (
      <div className={CARD} role="status">
        {error ? t('errors:agentBatch.fallback') : t('batch.loading')}
        {error && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
            {t('batch.refresh')}
          </Button>
        )}
      </div>
    )
  const save = () =>
    apply(() =>
      updateBatchPlan(batchId, {
        expectedVersion: page.batch.version,
        title: page.batch.title,
        rule: page.batch.rule,
        items: page.items,
      }),
    )
  const editable = page.batch.status === 'draft' && !busy
  return (
    <section id={domId} tabIndex={-1} className={CARD}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t('batch.scope', { count: page.items.length })}</span>
        <span>{t('batch.version', { version: page.batch.version })}</span>
      </div>
      <label className="grid gap-1 text-xs">
        {t('batch.title')}
        <Input
          value={page.batch.title}
          disabled={!editable}
          maxLength={120}
          onChange={(event) => {
            setPage({ ...page, batch: { ...page.batch, title: event.target.value } })
            setDirty(true)
          }}
        />
      </label>
      <label className="grid gap-1 text-xs">
        {t('batch.rule')}
        <Textarea
          value={page.batch.rule}
          disabled={!editable}
          maxLength={4000}
          onChange={(event) => {
            setPage({ ...page, batch: { ...page.batch, rule: event.target.value } })
            setDirty(true)
          }}
        />
      </label>
      <div className="max-h-96 overflow-y-auto divide-y divide-border rounded-lg border border-border bg-background">
        {page.items.map((item, index) => (
          <details key={item.key} className="px-2 py-1.5 text-xs">
            <summary className="cursor-pointer py-1 focus-visible:outline-ring">
              <span className="inline-flex max-w-full flex-wrap items-center gap-1 align-middle">
                <span className="shrink-0 tabular-nums">{index + 1}.</span>
                {item.inputs.map((input, inputIndex) => {
                  const name = input.name ?? t('batch.inputImage', { index: inputIndex + 1 })
                  return (
                    <span
                      key={`${input.imageId}:${inputIndex}`}
                      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-muted py-0.5 pl-0.5 pr-1.5"
                    >
                      <MediaImage
                        src={`aip-media:${input.mediaId}`}
                        alt={name}
                        className="h-7 w-7 shrink-0 rounded object-cover"
                        loading="lazy"
                      />
                      <span className="truncate">{name}</span>
                    </span>
                  )
                })}
              </span>
            </summary>
            <div className="grid gap-2 py-2">
              <label className="grid gap-1">
                {t('batch.prompt')}
                <Textarea
                  value={item.prompt}
                  disabled={!editable}
                  maxLength={4000}
                  onChange={(event) => {
                    setPage({
                      ...page,
                      items: page.items.map((entry) =>
                        entry.key === item.key ? { ...entry, prompt: event.target.value } : entry,
                      ),
                    })
                    setDirty(true)
                  }}
                />
              </label>
              <OutputParameters params={item.params} />
              <label className="grid gap-1">
                {t('batch.size')}
                <Input
                  aria-label={t('batch.size')}
                  value={
                    item.params.provider === 'gemini'
                      ? (item.params.gemini_image_size ?? '')
                      : (item.params.size ?? '')
                  }
                  disabled={!editable}
                  maxLength={32}
                  onChange={(event) => {
                    const params =
                      item.params.provider === 'gemini'
                        ? { ...item.params, gemini_image_size: event.target.value }
                        : { ...item.params, size: event.target.value }
                    setPage({
                      ...page,
                      items: page.items.map((entry) =>
                        entry.key === item.key ? { ...entry, params } : entry,
                      ),
                    })
                    setDirty(true)
                  }}
                />
              </label>
              <Button
                size="sm"
                variant="ghost"
                className="justify-self-start"
                disabled={
                  !editable ||
                  page.items.length <= 1 ||
                  page.items.some((entry) => entry.dependencies.includes(item.key))
                }
                onClick={() => {
                  setPage({
                    ...page,
                    items: page.items
                      .filter((entry) => entry.key !== item.key)
                      .map((entry, ordinal) => ({ ...entry, ordinal })),
                  })
                  setDirty(true)
                }}
              >
                {t('batch.remove')}
              </Button>
            </div>
          </details>
        ))}
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <span>{t('batch.analysisCost')}</span>
          <Estimate value={page.batch.estimate.analysis} />
        </div>
        <div className="flex justify-between">
          <span>{t('batch.generationCost')}</span>
          <Estimate value={page.batch.estimate.generation} />
        </div>
        {dirty && <p>{t('batch.staleQuote')}</p>}
      </div>
      {error && (
        <div className="grid justify-items-start gap-1">
          <p role="alert" className="text-xs text-destructive">
            {t(`errors:agentBatch.${error}`)}
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
            {t('batch.refresh')}
          </Button>
        </div>
      )}
      {page.batch.status === 'cancelled' ? (
        <p className={CARD_NOTE}>{t('batch.cancelled')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={
              !editable ||
              !dirty ||
              !page.batch.title.trim() ||
              !page.batch.rule.trim() ||
              page.items.some((item) => !item.prompt.trim())
            }
            onClick={() => void save()}
          >
            {t('batch.save')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!editable}
            onClick={() => void apply(() => cancelBatchPlan(batchId, page.batch.version))}
          >
            {t('batch.cancel')}
          </Button>
          <Button size="sm" disabled>
            {t('batch.confirm')}
          </Button>
          <span className={CARD_NOTE}>{t('batch.executionUnavailable')}</span>
        </div>
      )}
    </section>
  )
}
