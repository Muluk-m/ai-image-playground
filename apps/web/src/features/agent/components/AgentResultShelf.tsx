import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
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
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const [expanded, setExpanded] = useState(true)
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
        .slice(1, 13),
    [messages],
  )
  const signature = groups.map((message) => message.id).join(' ')

  useEffect(() => {
    let active = true
    void Promise.all(
      groups.map(async (message) => {
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
    return () => {
      active = false
    }
  }, [signature])

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
        <button type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t('resultShelf.collapse') : t('resultShelf.expand')}
        </button>
      </div>
      {expanded && (
        <div className="studio-result-shelf-items">
          {groups.map((message) => {
            const ids = resultIds(message)
            const placed = ids.every((id) => agentCanvasSink()?.has(id))
            return (
              <button
                key={message.id}
                type="button"
                onClick={() => void onSelect(message)}
                className="studio-result-shelf-item"
                title={message.title}
              >
                {previews[message.id] ? (
                  <img src={previews[message.id] ?? ''} alt="" />
                ) : (
                  <span className="studio-result-shelf-placeholder">✦</span>
                )}
                <span className="min-w-0">
                  <span className="block truncate">{message.title}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {placed ? t('resultShelf.locate') : t('resultShelf.place')}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
