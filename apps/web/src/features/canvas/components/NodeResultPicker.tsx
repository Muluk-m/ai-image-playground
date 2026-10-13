import {
  canvasMainResult,
  canvasNodeJobs,
  canvasResultIsStale,
  canvasResults,
} from '@image-playground/shared'
import { useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import type { CanvasEditor } from '../lib/editor'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import { selectNodeResult } from '../lib/nodeCanvasResults'
import {
  pendingNodeResults,
  retryNodeResultStorage,
  subscribePendingNodeResults,
} from '../lib/nodeResultPersistence'

/** Local BranchPicker adaptation: https://www.assistant-ui.com/docs/primitives/branch-picker
 * Same previous/count/next and boundary behavior; canvas results use Yjs rather than a chat runtime.
 */
export default function NodeResultPicker({
  canvas,
  editor,
  nodeId,
}: {
  canvas: NodeCanvasDocument
  editor: CanvasEditor
  nodeId: string
}) {
  const { t } = useTranslation('canvas')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const unsaved = useSyncExternalStore(
    (listener) => subscribePendingNodeResults(canvas.doc, listener),
    () => pendingNodeResults(canvas.doc, nodeId),
  )
  const active = useRef(false)
  const results = canvasResults(canvas.doc, nodeId)
  const main = canvasMainResult(canvas.doc, nodeId)
  const index = results.findIndex((result) => result.id === main?.id)
  const busy = loading || canvasNodeJobs(canvas.doc, nodeId).some((job) => job.status === 'loading')
  const stale = canvasResultIsStale(canvas.doc, nodeId)
  if (!results.length) return null
  async function choose(next: number) {
    const result = results[next]
    if (!result || active.current || busy) return
    active.current = true
    setLoading(true)
    canvas.undo.stopCapturing()
    try {
      await selectNodeResult(editor, canvas.doc, result.id, canvas.origin)
    } catch {
      useStore.getState().showToast(t('nodes.candidateUnavailable'), 'error')
    } finally {
      canvas.undo.stopCapturing()
      active.current = false
      setLoading(false)
    }
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{stale ? t('nodes.resultStale') : t('nodes.mainResult')}</span>
      {unsaved ? (
        <div role="status" className="flex w-full flex-wrap items-center gap-2 text-warning">
          <span>{t('nodes.candidateStorageFailed')}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              try {
                await retryNodeResultStorage(canvas.doc, nodeId)
              } finally {
                setSaving(false)
              }
            }}
          >
            {t('nodes.retryCandidateStorage')}
          </Button>
        </div>
      ) : null}
      {results.length > 1 || index < 0 ? (
        <div
          role="group"
          aria-label={t('nodes.candidates')}
          className="flex items-center gap-1 rounded-md border bg-muted/40 p-0.5"
        >
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy || index <= 0}
            aria-label={t('nodes.previousCandidate')}
            onClick={() => void choose(index - 1)}
          >
            <Icon name="chevronLeft" size="xs" />
          </Button>
          <span className="min-w-10 text-center tabular-nums" aria-live="polite">
            {index + 1} / {results.length}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy || index >= results.length - 1}
            aria-label={t('nodes.nextCandidate')}
            onClick={() => void choose(index + 1)}
          >
            <Icon name="chevronRight" size="xs" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
