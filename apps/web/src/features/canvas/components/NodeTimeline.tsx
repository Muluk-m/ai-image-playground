import type { CanvasNode, CanvasSnapshot } from '@image-playground/shared'
import { PROJECT_TIMELINE_MAX_CLIPS } from '@image-playground/shared'
import { createContext, useContext } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import type { CanvasEditor } from '../lib/editor'
import { timelineSeconds, timelineSegments } from '../lib/timeline'
import { useTimelineEditor } from '../timelineEditorStore'
import FilmExportButtons from './FilmExportButtons'
import NodeMediaImage from './NodeMediaImage'
import NodePorts from './NodePorts'

export const NodeTimelineContext = createContext<{
  editor: CanvasEditor
  snapshot: CanvasSnapshot
  onLocate: (id: string) => void
  onPick: (id: string) => void
} | null>(null)

/** Ordered source IDs remain stable when a shot gets a new primary result or temporarily has none. */
export default function NodeTimeline({
  node,
}: {
  node: Extract<CanvasNode, { type: 'timeline' }>
}) {
  const context = useContext(NodeTimelineContext)
  const { t } = useTranslation('canvas')
  if (!context) return null
  const { editor, snapshot, onLocate, onPick } = context
  const byId = new Map(snapshot.nodes.map((source) => [source.id, source]))
  const segments = timelineSegments(node.data.clips, (id) => editor.getElement(id))
  const missing = segments.filter((clip) => clip.missing).map((clip) => clip.index + 1)
  const seconds = timelineSeconds(node.data.clips, (id) => editor.getElement(id))
  return (
    <>
      <NodePorts nodeId={node.id} />
      <div className="studio-node-caption text-xs text-muted-foreground">
        <Icon name="list" size="xs" />
        {t('timeline.title')}
      </div>
      <div
        className="studio-node flex h-full flex-col gap-2 border border-border bg-card p-3 text-foreground"
        onDoubleClick={() => useTimelineEditor.getState().open(node.id)}
      >
        <div className="flex items-center justify-between gap-2 text-xs">
          <span>
            {t('nodes.timeline', { count: node.data.clips.length })} ·{' '}
            {t('timeline.seconds', { seconds: seconds.toFixed(1) })}
          </span>
          <Button
            className="nodrag nopan"
            variant="ghost"
            size="sm"
            onClick={() => useTimelineEditor.getState().open(node.id)}
          >
            <Icon name="play" />
            {t('timeline.edit')}
          </Button>
        </div>
        {node.data.clips.length > PROJECT_TIMELINE_MAX_CLIPS && (
          <p role="alert" className="px-3 text-xs text-destructive">
            {t('timeline.overflow', { max: PROJECT_TIMELINE_MAX_CLIPS })}
          </p>
        )}
        <ol
          className="nodrag nopan nowheel flex min-h-0 flex-1 gap-2 overflow-x-auto"
          aria-label={t('timeline.track')}
        >
          {segments.map((segment) => {
            const source = byId.get(segment.elementId)
            const poster =
              source && 'fileId' in source.data && source.data.fileId
                ? editor.doc.files[source.data.fileId]
                : undefined
            return (
              <li
                className="relative h-full min-h-0 w-24 shrink-0"
                key={`${segment.index}-${segment.elementId}`}
              >
                <Button
                  variant="ghost"
                  className="h-full w-full overflow-hidden rounded-md border border-border bg-muted p-0"
                  aria-label={t('timeline.locate', { index: segment.index + 1 })}
                  disabled={!source}
                  onClick={() => onLocate(segment.elementId)}
                >
                  {!segment.missing && poster ? (
                    <NodeMediaImage
                      src={poster}
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <Icon
                      name={segment.missing ? 'warning' : 'video'}
                      className="text-muted-foreground"
                    />
                  )}
                  <span className="absolute bottom-0 left-0 rounded-tr-md bg-background/90 px-1 text-xs tabular-nums">
                    {segment.index + 1} · {segment.seconds.toFixed(1)}s
                  </span>
                </Button>
              </li>
            )
          })}
          {segments.length === 0 && (
            <li className="flex w-full items-center justify-center text-xs text-muted-foreground">
              {t('timeline.connectHint')}
            </li>
          )}
        </ol>
        <div className="nodrag nopan flex flex-wrap items-center justify-between gap-1">
          <span role="status" className="text-xs text-muted-foreground">
            {missing.length > 0 ? t('timeline.missingShots', { indices: missing.join(', ') }) : ''}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('nodes.pickFromCanvas')}
            onClick={() => onPick(node.id)}
          >
            <Icon name="add" />
            {t('nodes.pickFromCanvas')}
          </Button>
          <FilmExportButtons editor={editor} timelineId={node.id} />
        </div>
      </div>
    </>
  )
}
