import type {
  AgentBatchEstimate,
  AgentBatchGenerationItem,
  AgentBatchPage,
  AgentBatchUpdate,
} from '@image-playground/shared'
import {
  Ban,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  Layers,
  Loader2,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Scan,
  TriangleAlert,
} from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { useStore } from '../../../store'
import { CARD, CARD_CONTROL, CARD_NOTE, CARD_TEXT } from '../agentStyles'
import {
  type AgentBatchCommand,
  AgentRequestError,
  cancelBatchPlan,
  fetchBatchPlan,
  updateBatchPlan,
} from '../lib/agentClient'
import { batchCommands } from '../lib/batchCommands'
import { batchResultFiles, exportBatchResults } from '../lib/batchResultExport'
import {
  BATCH_ITEM_PAGE_SIZE,
  type BatchDisplayStatus,
  batchGroupStartsOpen,
  batchItemStatus,
  focusedBatchItemStatusChange,
  groupBatchItems,
} from '../lib/batchStatusGroups'
import { useAgentStore } from '../store'
import AgentBatchAnalysisSummary from './AgentBatchAnalysisSummary'
import AgentBatchItemResult, {
  AgentBatchAnalysisEvidence,
  AgentBatchItemStatus,
} from './AgentBatchItemResult'

function statusIcon(status: BatchDisplayStatus) {
  if (status === 'in_flight' || status === 'in_progress') return Loader2
  if (status === 'completed') return CheckCircle2
  if (status === 'failed' || status === 'reconciling' || status === 'blocked') return TriangleAlert
  if (status === 'cancelled') return Ban
  return Clock3
}

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
          item.progress === 'reconciling' ||
          (item.execution &&
            ['queued', 'in_progress', 'reconciling'].includes(item.execution.status)),
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
  const [groupOverride, setGroupOverride] = useState<Record<string, boolean>>({})
  const [groupPage, setGroupPage] = useState<Record<string, number>>({})
  const [openItems, setOpenItems] = useState<ReadonlySet<string>>(() => new Set())
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null)
  const exporting = useRef(false)
  const seenStatus = useRef(new Map<string, string>())
  // 这次渲染开始时，焦点若还在某一条上，记下它的 key。用户已经点到分页、输入框或卡片外时这里是 null，
  // 随后的状态变化不能再把焦点抢回去。DOM 重排若发生在这次提交里，快照仍是重排前的那一条。
  const focusInRow = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const operations = useRef(0)
  const card = useRef<HTMLElement>(null)
  if (card.current) {
    const active = document.activeElement
    const row = active instanceof Element ? active.closest('details[data-item-key]') : null
    focusInRow.current =
      row && card.current.contains(row) ? row.getAttribute('data-item-key') : null
  }
  useLayoutEffect(() => {
    if (!page) return
    const moved = focusedBatchItemStatusChange(page.items, seenStatus.current, focusInRow.current)
    for (const item of page.items) seenStatus.current.set(item.key, batchItemStatus(item))
    if (!moved || !card.current) return
    const row = card.current.querySelector<HTMLElement>(
      `details[data-item-key="${CSS.escape(moved)}"]`,
    )
    if (!row) return
    const active = document.activeElement
    if (active && row.contains(active)) return
    // 焦点已经在别的控件上（分页、输入框、卡片外的按钮）时不抢。落到 body 才是重排把焦点弄丢了。
    if (active && active !== document.body && !row.contains(active)) return
    row.querySelector<HTMLElement>('summary')?.focus()
  }, [page, openItems])
  const commands = useMemo(() => batchCommands(batchId), [batchId])
  const [pending, setPending] = useState<AgentBatchCommand | null>(null)
  const [restored, setRestored] = useState(false)
  const [restorationFailed, setRestorationFailed] = useState(false)
  const [error, setError] = useState<'fallback' | 'batch_version_conflict' | null>(null)
  useEffect(() => {
    let active = true
    setRestored(false)
    setRestorationFailed(false)
    void fetchBatchPlan(batchId)
      .then((result) => {
        if (active && commands.current()) setPage(result)
      })
      .catch(() => {
        if (active && commands.current()) setError('fallback')
      })
    void commands
      .read()
      .then((command) => {
        if (active && commands.current()) {
          setPending(command)
          setRestored(true)
        }
      })
      .catch(() => {
        if (active && commands.current()) setRestorationFailed(true)
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
            setRestorationFailed(false)
          }
        } catch {
          if (commands.current()) {
            setRestored(false)
            setRestorationFailed(true)
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
  const resultFiles = batchResultFiles(
    page.items.map((item) => ({
      progress: item.progress,
      execution: item.execution,
      label: item.inputs.find((input) => input.name)?.name ?? '',
    })),
  )
  const runExport = async () => {
    if (exporting.current || resultFiles.length === 0) return
    exporting.current = true
    setExportProgress({ done: 0, total: resultFiles.length })
    try {
      const result = await exportBatchResults(resultFiles, {
        baseName: page.batch.title,
        onProgress: (done, total) => setExportProgress({ done, total }),
      })
      const { showToast } = useStore.getState()
      if (result.exported === 0) showToast(t('batch.exportFailed'), 'error')
      else if (result.failed > 0)
        showToast(
          t('batch.exportPartial', { count: result.exported, failed: result.failed }),
          'info',
        )
      else showToast(t('batch.exportDone', { count: result.exported }), 'success')
    } catch (cause) {
      // 取件失败已在 helper 里计数；走到这里的是打包或落盘本身出错。
      console.warn('[agent] batch result export failed', cause)
      useStore.getState().showToast(t('batch.exportFailed'), 'error')
    } finally {
      exporting.current = false
      setExportProgress(null)
    }
  }
  const grouped = page.items.some((item) => item.progress || item.execution)
  const groups = grouped ? groupBatchItems(page.items) : []
  const retryMarked = new Set(page.batch.retryItemKeys ?? [])
  const rememberItemOpen = (key: string, open: boolean) => {
    setOpenItems((current) => {
      if (current.has(key) === open) return current
      const next = new Set(current)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
  }
  const itemRow = (
    item: AgentBatchPage['items'][number],
    position: number,
    showStatus: boolean,
    className = '',
  ) => (
    <details
      key={item.key}
      data-item-key={item.key}
      data-batch-status={showStatus ? undefined : batchItemStatus(item)}
      className={`px-2 py-1 text-xs ${className}`}
      open={openItems.has(item.key)}
      onToggle={(event) => rememberItemOpen(item.key, event.currentTarget.open)}
    >
      <summary className="cursor-pointer py-0.5 focus-visible:outline-ring">
        <span className="inline-flex max-w-full flex-wrap items-center gap-1 align-middle">
          <span className="shrink-0 tabular-nums">{position}.</span>
          {showStatus ? (
            <AgentBatchItemStatus execution={item.execution} progress={item.progress} />
          ) : (
            <span className="sr-only">{t(`batch.itemStatus.${batchItemStatus(item)}`)}</span>
          )}
          {item.kind === 'analysis' && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5">
              <Scan aria-hidden className="h-3 w-3" />
              {t('batch.analysisKind')}
            </span>
          )}
          {phaseConfirmation?.itemKeys.includes(item.key) && (
            <span className="rounded-md border border-border bg-muted px-1.5 py-0.5">
              {t('batch.confirmationItem')}
            </span>
          )}
          {page.batch.retryItemKeys?.includes(item.key) && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5">
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
                  className="h-5 w-5 shrink-0 rounded object-cover"
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
              <span key={key} className="rounded-md border border-border bg-muted px-1.5 py-0.5">
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
            aria-label={t('batch.selectRetry', { index: position })}
            label={t('batch.selectRetry', { index: position })}
            onChange={(checked) =>
              setSelectedRetries((selected) =>
                checked ? [...selected, item.key] : selected.filter((key) => key !== item.key),
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
            className={`${CARD_TEXT} max-h-24`}
            rows={3}
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
            <AgentBatchAnalysisEvidence evidence={item.params.evidence} inputs={item.inputs} />
          </div>
        ) : (
          <>
            <OutputParameters params={item.params} />
            <label className="grid gap-1">
              {t('batch.size')}
              <Input
                className={`${CARD_CONTROL} w-full`}
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
  )

  const displayError = restorationFailed ? 'storage_restore_failed' : error
  const TargetIcon = page.batch.experience === 'canvas' ? Layers : MessageSquare
  return (
    <section ref={card} id={domId} tabIndex={-1} className={CARD}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t('batch.scope', { count: page.batch.itemCount })}</span>
        <span className="flex items-center gap-2">
          {resultFiles.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="text-foreground"
              disabled={exportProgress !== null}
              onClick={() => void runExport()}
            >
              <Download aria-hidden className="h-3 w-3" />
              {exportProgress
                ? t('batch.exporting', { done: exportProgress.done, total: exportProgress.total })
                : t('batch.exportResults', { count: resultFiles.length })}
            </Button>
          )}
          <span>{t('batch.version', { version: page.batch.version })}</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5">
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
          className={`${CARD_CONTROL} w-full`}
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
          className={`${CARD_TEXT} max-h-24`}
          rows={3}
          value={page.batch.rule}
          disabled={!editable}
          maxLength={4000}
          onChange={(event) => {
            setPage({ ...page, batch: { ...page.batch, rule: event.target.value } })
            markDirty()
          }}
        />
      </label>
      {grouped ? (
        <div className="max-h-64 overflow-y-auto" role="group" aria-label={t('batch.statusBoard')}>
          {groups.flatMap((group, groupAt) => {
            const containsRetry = group.items.some((item) => retryMarked.has(item.key))
            const pinned = group.items.some((item) => openItems.has(item.key))
            const open =
              groupOverride[group.status] ??
              (pinned ||
                batchGroupStartsOpen(
                  group.status,
                  group.items.length,
                  groups.length,
                  containsRetry,
                ))
            const groupPageCount = Math.max(1, Math.ceil(group.items.length / BATCH_ITEM_PAGE_SIZE))
            const groupIndex = Math.min(groupPageCount - 1, groupPage[group.status] ?? 0)
            const start = groupIndex * BATCH_ITEM_PAGE_SIZE
            const pageItems = group.items.slice(start, start + BATCH_ITEM_PAGE_SIZE)
            const visible = [
              ...pageItems,
              ...group.items.filter(
                (item, index) =>
                  openItems.has(item.key) &&
                  (index < start || index >= start + BATCH_ITEM_PAGE_SIZE),
              ),
            ]
            const showPager = open && groupPageCount > 1
            const Icon = statusIcon(group.status)
            const live = group.status === 'in_flight' || group.status === 'in_progress'
            const urgent =
              group.status === 'failed' ||
              group.status === 'blocked' ||
              group.status === 'reconciling'
            const header = (
              <div
                key={`group:${group.status}`}
                data-batch-group={group.status}
                className={`${groupAt === 0 ? '' : 'mt-1'} overflow-hidden border border-border bg-background ${open ? 'rounded-t-lg border-b-0' : 'rounded-lg'}`}
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs text-foreground hover:bg-muted/60"
                  aria-expanded={open}
                  onClick={() =>
                    setGroupOverride((current) => ({ ...current, [group.status]: !open }))
                  }
                >
                  <ChevronRight
                    aria-hidden
                    className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  <Icon
                    aria-hidden
                    className={`h-3 w-3 shrink-0 ${live ? 'animate-spin text-foreground' : urgent ? 'text-destructive' : 'text-muted-foreground'}`}
                  />
                  <span>{t(`batch.itemStatus.${group.status}`)}</span>
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {group.items.length}
                  </span>
                </button>
              </div>
            )
            if (!open) return [header]
            const rows = visible.map((item, index) =>
              itemRow(
                item,
                page.items.findIndex((entry) => entry.key === item.key) + 1,
                false,
                `border-x border-t border-border bg-background ${index === visible.length - 1 && !showPager ? 'rounded-b-lg border-b' : ''}`,
              ),
            )
            if (!showPager) return [header, ...rows]
            return [
              header,
              ...rows,
              <nav
                key={`pages:${group.status}`}
                aria-label={t('batch.pagination')}
                className="flex items-center justify-between gap-2 rounded-b-lg border border-t-0 border-border bg-background px-2 py-1 text-xs"
              >
                <Button
                  size="sm"
                  variant="outline"
                  disabled={groupIndex === 0}
                  onClick={() =>
                    setGroupPage((current) => ({
                      ...current,
                      [group.status]: groupIndex - 1,
                    }))
                  }
                >
                  {t('batch.previousPage')}
                </Button>
                <span className="tabular-nums">
                  {t('batch.pagePosition', {
                    current: groupIndex + 1,
                    total: groupPageCount,
                  })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={groupIndex + 1 === groupPageCount}
                  onClick={() =>
                    setGroupPage((current) => ({
                      ...current,
                      [group.status]: groupIndex + 1,
                    }))
                  }
                >
                  {t('batch.nextPage')}
                </Button>
              </nav>,
            ]
          })}
        </div>
      ) : (
        <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-background">
          {visibleItems.map((item, index) => itemRow(item, firstItem + index + 1, true))}
        </div>
      )}
      {!grouped && pageCount > 1 && (
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
      {displayError && (restorationFailed || !pending) && (
        <div className="grid justify-items-start gap-1">
          <p role="alert" className="text-xs text-destructive">
            {t(`errors:agentBatch.${displayError}`)}
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
