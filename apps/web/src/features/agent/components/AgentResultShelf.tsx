import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '../../../components/ui/button'
import { OverflowText } from '../../../components/ui/overflowTitle'
import { useTranslation } from '../../../i18n'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import { fetchedCanvasId } from '../lib/artifactDelivery'
import { artifactPreview, fetchedImagePreview } from '../lib/artifactPreview'
import { agentCanvasSink } from '../lib/canvasSink'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'

function resultIds(message: AgentToolMessage): string[] {
  return (
    message.artifacts?.map((artifact) => artifact.artifactId) ??
    message.fetchedImages?.map((_, index) => fetchedCanvasId(message.toolCallId, index)) ??
    []
  )
}

export default function AgentResultShelf({ doc }: { doc: CanvasDoc }) {
  const { t } = useTranslation('agent')
  const messages = useAgentStore((state) => state.messages)
  const files = useSyncExternalStore(doc.subscribe, () => doc.files)
  const [expanded, setExpanded] = useState(true)
  const [visibleCount, setVisibleCount] = useState(8)
  const [previews, setPreviews] = useState<Record<string, string | null>>({})
  const groups = useMemo(
    () =>
      messages
        .filter(
          (message): message is AgentToolMessage =>
            message.kind === 'tool' &&
            message.status === 'succeeded' &&
            Boolean(message.artifacts?.length || message.fetchedImages?.length),
        )
        .reverse()
        .slice(1),
    [messages],
  )
  const visibleGroups = groups.slice(0, visibleCount)
  const signature = visibleGroups.map((message) => `${message.id}:${message.delivery}`).join(' ')
  const elementSignature = useSyncExternalStore(doc.subscribe, () => {
    const ids = new Set(visibleGroups.flatMap(resultIds))
    return JSON.stringify(
      doc.elements
        .filter((element) => ids.has(element.id))
        .map((element) =>
          element.type === 'image'
            ? [element.id, element.fileId, element.width, element.height, element.rotation]
            : [element.id, element.type],
        ),
    )
  })

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      void Promise.all(
        visibleGroups.map(async (message) => {
          const first = message.artifacts?.[0]
          const fetched = message.fetchedImages?.[0]
          const preview = await (first
            ? artifactPreview(first)
            : fetched
              ? fetchedImagePreview(fetched, fetchedCanvasId(message.toolCallId, 0))
              : Promise.resolve(null)
          ).catch(() => null)
          return [message.id, preview?.source ?? null] as const
        }),
      ).then((items) => {
        if (active) setPreviews(Object.fromEntries(items))
      })
    }, 150)
    return () => {
      clearTimeout(timer)
      active = false
    }
  }, [signature, elementSignature, files])

  if (!groups.length) return null
  const onSelect = async (message: AgentToolMessage) => {
    const ids = resultIds(message)
    if (ids.some((id) => !agentCanvasSink()?.has(id)))
      await useAgentStore.getState().placeOnCanvas(message.id)
    agentCanvasSink()?.focus(ids)
  }

  return (
    <div className="studio-result-shelf" aria-label={t('resultShelf.title')}>
      <div className="studio-result-shelf-head">
        <strong>{t('resultShelf.title')}</strong>
        <span>{t('resultShelf.count', { count: groups.length })}</span>
        <Button
          type="button"
          variant="ghost"
          className="ml-auto h-auto px-1 py-0 text-xs font-normal text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('resultShelf.collapse') : t('resultShelf.expand')}
        </Button>
      </div>
      {expanded && (
        <div className="studio-result-shelf-items">
          {visibleGroups.map((message) => {
            const ids = resultIds(message)
            const placed = ids.every((id) => agentCanvasSink()?.has(id))
            return (
              <Button
                key={message.id}
                type="button"
                variant="ghost"
                onClick={() => void onSelect(message)}
                className="studio-result-shelf-item h-auto justify-start gap-2 rounded-lg border border-border bg-card p-1 text-left text-xs font-normal hover:border-primary/60 hover:bg-card"
              >
                {previews[message.id] ? (
                  <img src={previews[message.id] ?? ''} alt="" />
                ) : (
                  <span className="studio-result-shelf-placeholder">✦</span>
                )}
                <span className="min-w-0">
                  <OverflowText text={message.title} className="block truncate" />
                  <span className="text-label-sm text-muted-foreground">
                    {placed ? t('resultShelf.locate') : t('resultShelf.place')}
                  </span>
                </span>
              </Button>
            )
          })}
          {visibleCount < groups.length && (
            <Button
              type="button"
              variant="ghost"
              className="studio-result-shelf-more h-auto self-stretch rounded-lg border border-dashed border-border px-2 py-1 text-label-sm font-normal text-muted-foreground hover:border-primary/60 hover:bg-transparent hover:text-foreground"
              onClick={() => setVisibleCount((count) => count + 8)}
            >
              {t('resultShelf.more', { count: Math.min(8, groups.length - visibleCount) })}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
