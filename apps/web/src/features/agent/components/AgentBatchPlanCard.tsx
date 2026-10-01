import type {
  AgentBatchEstimate,
  AgentBatchGenerationItem,
  AgentBatchPage,
  AgentBatchUpdate,
} from '@image-playground/shared'
import { Layers, MessageSquare, PauseCircle, PlayCircle, RotateCcw, Scan } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox } from '../../../components/Checkbox'
import Credits from '../../../components/Credits'
import MediaImage from '../../../components/MediaImage'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { scopedStorageName } from '../../../lib/authScope'
import { getDeviceId } from '../../../lib/deviceId'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { CARD, CARD_NOTE } from '../agentStyles'
import {
  type AgentBatchCommand,
  AgentRequestError,
  cancelBatchPlan,
  fetchBatchPlan,
  updateBatchPlan,
} from '../lib/agentClient'
import { batchCommands } from '../lib/batchCommands'
import { useAgentStore } from '../store'
import AgentBatchAnalysisSummary from './AgentBatchAnalysisSummary'
import AgentBatchItemResult, {
  AgentBatchAnalysisEvidence,
  AgentBatchItemStatus,
} from './AgentBatchItemResult'

function readReviewPage(key: string): number {
  try {
    return Number(sessionStorage.getItem(key) ?? 0)
  } catch {
    return 0
  }
}

function hasActiveWork(page: AgentBatchPage | null): boolean {
  return (
    page?.batch.status === 'running' ||
    (page?.batch.status === 'paused' &&
      page.items.some(
        (item) =>
          item.execution &&
          ['queued', 'in_progress', 'reconciling'].includes(item.execution.status),
      ))
  )
}

function Estimate({ value }: { value: AgentBatchEstimate }) {
  const { t } = useTranslation('agent')
  return value.status === 'available' ? (
    <Credits credits={value.estimatedChargeCredits} />
  ) : (
    <span>{t('batch.unavailable')}</span>
  )
}

/** Provider parameter names stay in the protocol; the review card uses user-facing labels. */
function OutputParameters({ params }: { params: AgentBatchGenerationItem['params'] }) {
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
  const [selectedRetries, setSelectedRetries] = useState<readonly string[]>([])
  const [reviewPage, setReviewPage] = useState<{ key: string; index: number }>()
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const operations = useRef(0)
  const card = useRef<HTMLElement>(null)
  const commands = useMemo(() => batchCommands(batchId), [batchId])
  const [pending, setPending] = useState<AgentBatchCommand | null>(null)
  const [restored, setRestored] = useState(false)
  const [error, setError] = useState<'fallback' | 'batch_version_conflict' | null>(null)
  useEffect(() => {
    let active = true
    setRestored(false)
    void Promise.all([fetchBatchPlan(batchId), commands.read()])
      .then(([result, command]) => {
        if (active && commands.current()) {
          setPage(result)
          setPending(command)
          setRestored(true)
        }
      })
      .catch(() => {
        if (active && commands.current()) setError('fallback')
      })
    return () => {
      active = false
    }
  }, [batchId, commands])
  const apply = async (request: () => Promise<AgentBatchPage>, control = false) => {
    if (working.current || !commands.current()) return
    working.current = true
    operations.current++
    setBusy(true)
    setError(null)
    try {
      const result = await request()
      if (!commands.current()) return
      setPage(result)
      setDirty(false)
      setSelectedRetries([])
    } catch (cause) {
      if (!commands.current()) return
      setError(
        cause instanceof AgentRequestError && cause.code === 'batch_version_conflict'
          ? 'batch_version_conflict'
          : 'fallback',
      )
    } finally {
      if (control)
        try {
          const command = await commands.read()
          if (commands.current()) {
            setPending(command)
            setRestored(true)
          }
        } catch {
          if (commands.current()) {
            setRestored(false)
            setError('fallback')
          }
        }
      working.current = false
      setBusy(false)
    }
  }
  const markDirty = () => {
    operations.current++
    setDirty(true)
  }
  const activeConversation = useAgentStore((state) => state.conversationId)
  const activeTurn = useAgentStore((state) => state.turn)
  const completedConversation = page?.batch.status === 'closed' ? page.batch.conversationId : null
  const completedVersion = page?.batch.version
  useEffect(() => {
    if (
      completedConversation &&
      completedVersion &&
      completedConversation === activeConversation &&
      activeTurn !== 'running' &&
      commands.current()
    )
      useAgentStore.getState().followBatchWake(completedConversation, batchId, completedVersion)
  }, [completedConversation, completedVersion, activeConversation, activeTurn, batchId, commands])
  const watch = hasActiveWork(page)
  useEffect(() => {
    if (!watch || dirty) return
    let active = true
    let visible = true
    let reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (active && visible && !document.hidden && !timer && !reading)
        timer = setTimeout(() => void poll(), 3_000)
    }
    const poll = async () => {
      timer = undefined
      if (!active || !visible || document.hidden || !commands.current()) return
      if (working.current) {
        schedule()
        return
      }
      reading = true
      const operation = operations.current
      try {
        const result = await fetchBatchPlan(batchId)
        if (active && commands.current() && operation === operations.current) {
          setPage(result)
          if (!hasActiveWork(result)) active = false
        }
      } catch {
        if (active && commands.current() && operation === operations.current) setError('fallback')
      } finally {
        reading = false
        schedule()
      }
    }
    const visibility = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      schedule()
    }
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting)
            visibility()
          })
    if (card.current) observer?.observe(card.current)
    document.addEventListener('visibilitychange', visibility)
    schedule()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      observer?.disconnect()
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [watch, batchId, commands, dirty])
  const refresh = () => apply(() => fetchBatchPlan(batchId), true)
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
        items: page.items.map((item): AgentBatchUpdate['items'][number] => {
          const base = {
            key: item.key,
            ordinal: item.ordinal,
            inputs: item.inputs,
            prompt: item.prompt,
            dependencies: item.dependencies,
          }
          return item.kind === 'analysis'
            ? { ...base, kind: 'analysis', params: { model: item.params.model } }
            : { ...base, kind: 'generation', params: item.params }
        }),
      }),
    )
  const phaseConfirmation = page.batch.confirmationRequired ? page.batch.confirmation : undefined
  const editable =
    (page.batch.status === 'draft' ||
      (page.batch.status === 'paused' &&
        Boolean(phaseConfirmation) &&
        !page.batch.retryItemKeys?.length)) &&
    !busy &&
    restored &&
    !pending &&
    !page.nextCursor
  const itemEditable = (item: AgentBatchPage['items'][number]) =>
    editable &&
    !item.execution &&
    (!phaseConfirmation || phaseConfirmation.itemKeys.includes(item.key))
  const canSave =
    editable &&
    dirty &&
    Boolean(page.batch.title.trim()) &&
    Boolean(page.batch.rule.trim()) &&
    page.items.every((item) => item.prompt.trim())
  const command = (action: Exclude<AgentBatchCommand['action'], 'retry-quote'>) =>
    apply(
      () =>
        commands.execute(
          action === 'pause' || action === 'reprice'
            ? { action, commandId: crypto.randomUUID(), expectedVersion: page.batch.version }
            : {
                action,
                commandId: crypto.randomUUID(),
                expectedVersion: page.batch.version,
                expectedDigest: page.batch.digest,
                deviceId: getDeviceId(),
              },
        ),
      true,
    )
  const confirmationKeys = page.batch.retryItemKeys?.length
    ? page.batch.retryItemKeys
    : phaseConfirmation?.itemKeys
  const pricedItems = confirmationKeys?.length
    ? page.items.filter((item) => confirmationKeys.includes(item.key))
    : page.items
  const hasAnalysis = pricedItems.some((item) => item.kind === 'analysis')
  const hasGeneration = pricedItems.some((item) => item.kind === 'generation')
  const confirmLabel =
    phaseConfirmation?.phase === 'analysis'
      ? t('batch.confirmAnalysis')
      : phaseConfirmation?.phase === 'generation'
        ? t('batch.confirm')
        : hasAnalysis
          ? t('batch.confirmExecution')
          : t('batch.confirm')
  const confirmable =
    page.batch.executionEnabled &&
    restored &&
    !pending &&
    !dirty &&
    !busy &&
    !page.nextCursor &&
    page.items.length === page.batch.itemCount &&
    (!phaseConfirmation ||
      (phaseConfirmation.itemKeys.length > 0 &&
        phaseConfirmation.itemKeys.every((key) => page.items.some((item) => item.key === key)))) &&
    (!hasGeneration || page.batch.estimate.generation.status === 'available') &&
    (!hasAnalysis || page.batch.estimate.analysis.status === 'available')
  const priceChanged = page.batch.status === 'paused' && page.batch.pauseReason === 'price_changed'
  const retryConfirmation = Boolean(
    page.batch.confirmationRequired && page.batch.retryItemKeys?.length,
  )
  const retryEligible = (item: AgentBatchPage['items'][number]) =>
    page.batch.executionEnabled &&
    !page.batch.confirmationRequired &&
    page.batch.status !== 'draft' &&
    page.batch.status !== 'cancelled' &&
    (item.progress ?? item.execution?.status) === 'failed' &&
    item.execution?.errorCode !== 'result_unknown'
  const retryKeys = page.items
    .filter((item) => retryEligible(item) && selectedRetries.includes(item.key))
    .map((item) => item.key)
  const quoteRetry = () =>
    apply(
      () =>
        commands.execute({
          action: 'retry-quote',
          commandId: crypto.randomUUID(),
          expectedVersion: page.batch.version,
          itemKeys: retryKeys,
        }),
      true,
    )
  const sourceVersions = page.batch.confirmation?.sourceVersions
  const singleSourceVersion = sourceVersions?.length
    ? sourceVersions.length === 1
      ? sourceVersions[0]
      : undefined
    : page.batch.confirmation?.sourceVersion
  const pageSize = 20
  const pageKey = scopedStorageName(
    `agent-batch-page:${bffBaseUrl()}:${batchId}:${page.batch.version}`,
  )
  const rememberedPage = reviewPage?.key === pageKey ? reviewPage.index : readReviewPage(pageKey)
  const pageCount = Math.max(1, Math.ceil(page.items.length / pageSize))
  const pageIndex = Math.min(
    pageCount - 1,
    Number.isSafeInteger(rememberedPage) ? Math.max(0, rememberedPage) : 0,
  )
  const firstItem = pageIndex * pageSize
  const visibleItems = page.items.slice(firstItem, firstItem + pageSize)
  const showPage = (index: number) => {
    if (!commands.current()) return
    const next = Math.max(0, Math.min(pageCount - 1, index))
    setReviewPage({ key: pageKey, index: next })
    try {
      sessionStorage.setItem(pageKey, String(next))
    } catch {
      // Page position is optional; the in-memory view remains usable without storage.
    }
  }
  const TargetIcon = page.batch.experience === 'canvas' ? Layers : MessageSquare
  return (
    <section ref={card} id={domId} tabIndex={-1} className={CARD}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t('batch.scope', { count: page.batch.itemCount })}</span>
        <span>{t('batch.version', { version: page.batch.version })}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1">
          <TargetIcon aria-hidden className="h-3 w-3" />
          {page.batch.experience === 'canvas' ? t('batch.targetCanvas') : t('batch.targetChat')}
        </span>
        {page.batch.status === 'running' ||
        page.batch.status === 'paused' ||
        page.batch.status === 'closed' ? (
          <span>
            {t('batch.submitted', {
              count: page.batch.submittedCount ?? 0,
            })}
          </span>
        ) : null}
        {page.batch.status === 'paused' && (
          <span className="inline-flex items-center gap-1">
            <PauseCircle aria-hidden className="h-3 w-3" />
            {t('batch.paused')}
          </span>
        )}
      </div>
      {page.analysisSummary && (
        <AgentBatchAnalysisSummary summary={page.analysisSummary} items={page.items} />
      )}
      {page.sourceAnalysisSummary && (
        <AgentBatchAnalysisSummary
          summary={page.sourceAnalysisSummary}
          items={page.items}
          sourceVersion={page.batch.confirmation?.sourceVersion}
          sourceVersions={sourceVersions}
        />
      )}
      {Boolean(
        page.batch.confirmation?.excludedItemKeys?.length ||
          page.batch.confirmation?.excludedImageIds?.length,
      ) && (
        <div className="grid gap-1 rounded-lg border border-border bg-muted p-2 text-xs">
          <span className="font-medium">{t('batch.excludedScope')}</span>
          {page.batch.confirmation?.excludedImageIds?.map((imageId) => {
            const name = page.items
              .flatMap((item) => item.inputs)
              .find((input) => input.imageId === imageId)?.name
            const index = page.sourceAnalysisSummary?.requiredImageIds.indexOf(imageId) ?? -1
            return (
              <span key={imageId}>
                {name ?? (index >= 0 ? t('batch.inputImage', { index: index + 1 }) : imageId)}
              </span>
            )
          })}
          {page.batch.confirmation?.excludedItemKeys?.length ? (
            <span>
              {t('batch.excludedItems', {
                items: page.batch.confirmation.excludedItemKeys.join(' · '),
              })}
            </span>
          ) : null}
          {Boolean(page.sourceAnalysisSummary?.unresolvedItemKeys.length) && (
            <span className="text-muted-foreground">{t('batch.excludedPending')}</span>
          )}
        </div>
      )}
      <label className="grid gap-1 text-xs">
        {t('batch.title')}
        <Input
          value={page.batch.title}
          disabled={!editable}
          maxLength={120}
          onChange={(event) => {
            setPage({ ...page, batch: { ...page.batch, title: event.target.value } })
            markDirty()
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
            markDirty()
          }}
        />
      </label>
      <div className="max-h-96 overflow-y-auto divide-y divide-border rounded-lg border border-border bg-background">
        {visibleItems.map((item, index) => (
          <details key={item.key} className="px-2 py-1.5 text-xs">
            <summary className="cursor-pointer py-1 focus-visible:outline-ring">
              <span className="inline-flex max-w-full flex-wrap items-center gap-1 align-middle">
                <span className="shrink-0 tabular-nums">{firstItem + index + 1}.</span>
                <AgentBatchItemStatus execution={item.execution} progress={item.progress} />
                {item.kind === 'analysis' && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1">
                    <Scan aria-hidden className="h-3 w-3" />
                    {t('batch.analysisKind')}
                  </span>
                )}
                {phaseConfirmation?.itemKeys.includes(item.key) && (
                  <span className="rounded-md border border-border bg-muted px-2 py-1">
                    {t('batch.confirmationItem')}
                  </span>
                )}
                {page.batch.retryItemKeys?.includes(item.key) && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1">
                    <RotateCcw aria-hidden className="h-3 w-3" />
                    {t('batch.retryItem')}
                  </span>
                )}
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
              {item.blockedBy?.length ? (
                <div className="flex flex-wrap gap-1">
                  {item.blockedBy.map((key) => (
                    <span key={key} className="rounded-md border border-border bg-muted px-2 py-1">
                      {t('batch.dependencyItem', {
                        index: page.items.findIndex((entry) => entry.key === key) + 1,
                      })}
                    </span>
                  ))}
                </div>
              ) : null}
              {retryEligible(item) && (
                <Checkbox
                  checked={selectedRetries.includes(item.key)}
                  disabled={busy || !restored || Boolean(pending)}
                  aria-label={t('batch.selectRetry', { index: firstItem + index + 1 })}
                  label={t('batch.selectRetry', { index: firstItem + index + 1 })}
                  onChange={(checked) =>
                    setSelectedRetries((selected) =>
                      checked
                        ? [...selected, item.key]
                        : selected.filter((key) => key !== item.key),
                    )
                  }
                />
              )}
              {item.execution && (
                <div className="grid gap-1">
                  <span>{t('batch.attempt', { number: item.execution.attempt })}</span>
                  <AgentBatchItemStatus execution={item.execution} />
                  <AgentBatchItemResult execution={item.execution} inputs={item.inputs} />
                </div>
              )}
              {item.attempts?.some((attempt) => attempt.attempt !== item.execution?.attempt) ? (
                <details className="rounded-md border border-border p-2">
                  <summary className="cursor-pointer">{t('batch.previousAttempts')}</summary>
                  <div className="grid gap-3 pt-2">
                    {item.attempts
                      .filter((attempt) => attempt.attempt !== item.execution?.attempt)
                      .map((attempt) => (
                        <div key={attempt.attempt} className="grid gap-1">
                          <span>{t('batch.attempt', { number: attempt.attempt })}</span>
                          <AgentBatchItemStatus execution={attempt} />
                          <AgentBatchItemResult execution={attempt} inputs={item.inputs} />
                        </div>
                      ))}
                  </div>
                </details>
              ) : null}
              <label className="grid gap-1">
                {t('batch.prompt')}
                <Textarea
                  value={item.prompt}
                  disabled={!itemEditable(item)}
                  maxLength={4000}
                  onChange={(event) => {
                    setPage({
                      ...page,
                      items: page.items.map((entry) =>
                        entry.key === item.key ? { ...entry, prompt: event.target.value } : entry,
                      ),
                    })
                    markDirty()
                  }}
                />
              </label>
              {item.kind === 'generation' && item.sourceAnalysis?.length ? (
                <div className="grid gap-2 rounded-md bg-muted p-2">
                  <span className="font-medium">{t('batch.generationSource')}</span>
                  {item.sourceAnalysis.map((source) => {
                    const findings =
                      page.sourceAnalysisSummary?.findings.filter(
                        (finding) =>
                          finding.itemKey === source.itemKey &&
                          finding.taskId === source.taskId &&
                          finding.attempt === source.attempt &&
                          (finding.version ?? singleSourceVersion) ===
                            (source.version ?? singleSourceVersion),
                      ) ?? []
                    return (
                      <div
                        key={`${source.version ?? 'legacy'}:${source.taskId}:${source.attempt}`}
                        className="grid gap-1"
                      >
                        <span className="text-muted-foreground" title={source.taskId}>
                          {(source.version ?? singleSourceVersion) !== undefined && (
                            <>
                              {t('batch.version', {
                                version: source.version ?? singleSourceVersion,
                              })}{' '}
                              ·{' '}
                            </>
                          )}
                          {t('batch.attempt', { number: source.attempt })}
                        </span>
                        {findings.length ? (
                          findings.map((finding) => (
                            <p key={finding.imageId} className="whitespace-pre-wrap break-words">
                              {finding.text}
                            </p>
                          ))
                        ) : (
                          <span>{t('batch.sourceUnavailable')}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : null}
              {item.kind === 'analysis' ? (
                <div className="grid gap-2">
                  <dl className="flex justify-between">
                    <dt>{t('batch.model')}</dt>
                    <dd>{item.params.model}</dd>
                  </dl>
                  <AgentBatchAnalysisEvidence
                    evidence={item.params.evidence}
                    inputs={item.inputs}
                  />
                </div>
              ) : (
                <>
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
                      disabled={!itemEditable(item)}
                      maxLength={32}
                      onChange={(event) => {
                        const params =
                          item.params.provider === 'gemini'
                            ? { ...item.params, gemini_image_size: event.target.value }
                            : { ...item.params, size: event.target.value }
                        setPage({
                          ...page,
                          items: page.items.map((entry) =>
                            entry.key === item.key && entry.kind === 'generation'
                              ? { ...entry, params }
                              : entry,
                          ),
                        })
                        markDirty()
                      }}
                    />
                  </label>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="justify-self-start"
                disabled={
                  !itemEditable(item) ||
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
                  markDirty()
                }}
              >
                {t('batch.remove')}
              </Button>
            </div>
          </details>
        ))}
      </div>
      {pageCount > 1 && (
        <nav
          aria-label={t('batch.pagination')}
          className="flex items-center justify-between gap-2 text-xs"
        >
          <Button
            size="sm"
            variant="outline"
            disabled={pageIndex === 0}
            onClick={() => showPage(pageIndex - 1)}
          >
            {t('batch.previousPage')}
          </Button>
          <span className="tabular-nums">
            {t('batch.pagePosition', { current: pageIndex + 1, total: pageCount })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={pageIndex + 1 === pageCount}
            onClick={() => showPage(pageIndex + 1)}
          >
            {t('batch.nextPage')}
          </Button>
        </nav>
      )}
      <div className="grid gap-1 text-xs text-muted-foreground">
        {(!confirmationKeys?.length || hasAnalysis) && (
          <div className="flex justify-between">
            <span>
              {page.batch.retryItemKeys?.length
                ? t('batch.analysisRetryCost')
                : t('batch.analysisCost')}
            </span>
            <Estimate value={page.batch.estimate.analysis} />
          </div>
        )}
        {hasGeneration && (
          <div className="flex justify-between">
            <span>
              {page.batch.retryItemKeys?.length ? t('batch.retryCost') : t('batch.generationCost')}
            </span>
            <Estimate value={page.batch.estimate.generation} />
          </div>
        )}
        {typeof page.batch.actualCredits === 'number' && page.batch.status !== 'draft' && (
          <div className="flex justify-between">
            <span>{t('batch.actualCost')}</span>
            <Credits credits={page.batch.actualCredits} />
          </div>
        )}
        {dirty && <p>{t('batch.staleQuote')}</p>}
        {priceChanged && <p role="status">{t('errors:agentBatch.batch_price_changed')}</p>}
        {page.batch.status === 'paused' &&
          page.batch.pauseReason &&
          page.batch.pauseReason !== 'price_changed' && (
            <p role="status">{t(`errors:agentBatch.${page.batch.pauseReason}`)}</p>
          )}
        {phaseConfirmation?.requiresResume && !retryConfirmation && (
          <p>{t('batch.phaseKeepsPaused')}</p>
        )}
        {!page.batch.confirmationRequired &&
          page.batch.status === 'paused' &&
          page.batch.confirmation?.requiresResume &&
          !page.batch.retryItemKeys?.length && (
            <p role="status">{t('batch.phaseConfirmedPaused')}</p>
          )}
        {retryConfirmation && page.batch.retryRequiresResume && (
          <p>{t('batch.retryKeepsPaused')}</p>
        )}
        {!page.batch.confirmationRequired &&
        page.batch.status === 'paused' &&
        page.batch.retryItemKeys?.length &&
        page.batch.retryRequiresResume ? (
          <p role="status">{t('batch.retryConfirmedPaused')}</p>
        ) : null}
      </div>
      {pending && (
        <div className="grid justify-items-start gap-1">
          <p role="status" className={CARD_NOTE}>
            {t('batch.commandPending')}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !restored}
            onClick={() => void apply(() => commands.execute(pending), true)}
          >
            {t('batch.checkCommand')}
          </Button>
        </div>
      )}
      {error && !pending && (
        <div className="grid justify-items-start gap-1">
          <p role="alert" className="text-xs text-destructive">
            {t(`errors:agentBatch.${error}`)}
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
            {t('batch.refresh')}
          </Button>
        </div>
      )}
      {page.items.some(retryEligible) && (
        <Button
          size="sm"
          variant="outline"
          disabled={!retryKeys.length || busy || !restored || Boolean(pending)}
          onClick={() => void quoteRetry()}
        >
          {t('batch.quoteRetry')}
        </Button>
      )}
      {retryConfirmation ? (
        <Button size="sm" disabled={!confirmable} onClick={() => void command('confirm')}>
          {t('batch.confirmRetry')}
        </Button>
      ) : phaseConfirmation ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!canSave} onClick={() => void save()}>
            {t('batch.save')}
          </Button>
          <Button size="sm" disabled={!confirmable} onClick={() => void command('confirm')}>
            {confirmLabel}
          </Button>
        </div>
      ) : page.batch.status === 'cancelled' ? (
        <p className={CARD_NOTE}>{t('batch.cancelled')}</p>
      ) : page.batch.status === 'running' ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !restored || Boolean(pending)}
          onClick={() => void command('pause')}
        >
          <PauseCircle aria-hidden className="mr-1 h-3 w-3" />
          {t('batch.pause')}
        </Button>
      ) : priceChanged ? (
        page.batch.confirmationRequired ? (
          <Button size="sm" disabled={!confirmable} onClick={() => void command('confirm')}>
            {confirmLabel}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!page.batch.executionEnabled || busy || !restored || Boolean(pending)}
            onClick={() => void command('reprice')}
          >
            {t('batch.reprice')}
          </Button>
        )
      ) : page.batch.status === 'paused' ? (
        <Button size="sm" disabled={!confirmable} onClick={() => void command('resume')}>
          <PlayCircle aria-hidden className="mr-1 h-3 w-3" />
          {t('batch.resume')}
        </Button>
      ) : page.batch.status === 'draft' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!canSave} onClick={() => void save()}>
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
          <Button size="sm" disabled={!confirmable} onClick={() => void command('confirm')}>
            {confirmLabel}
          </Button>
          {!page.batch.executionEnabled && (
            <span className={CARD_NOTE}>{t('batch.executionUnavailable')}</span>
          )}
        </div>
      ) : null}
    </section>
  )
}
