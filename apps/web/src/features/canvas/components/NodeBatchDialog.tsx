import type { CanvasSnapshot } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import Credits from '../../../components/Credits'
import Dialog from '../../../components/patterns/Dialog'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { useVideoStore } from '../../video/store'
import type { CanvasEditor } from '../lib/editor'
import {
  currentNodeBatch,
  type NodeBatchError,
  NodeBatchFailure,
  type NodeBatchPlan,
  runNodeBatch,
} from '../lib/nodeBatch'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import NodeBatchJobs from './NodeBatchJobs'

export default function NodeBatchDialog({
  canvas,
  editor,
  ids,
  snapshot,
  initialPlan,
  onClose,
}: {
  canvas: NodeCanvasDocument
  editor: CanvasEditor
  ids: readonly string[]
  initialPlan?: NodeBatchPlan
  snapshot: CanvasSnapshot
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  // Subscribe to settings as well as parent document updates so a visible quote never silently changes.
  useStore((state) => state.settings)
  useStore((state) => state.params)
  useVideoStore((state) => state.draft)
  const [plan, setPlan] = useState(() => initialPlan ?? currentNodeBatch(canvas.doc, editor, ids))
  const [status, setStatus] = useState<'ready' | 'running' | 'done' | 'error'>('ready')
  const [completed, setCompleted] = useState(0),
    [active, setActive] = useState(''),
    [failure, setFailure] = useState<NodeBatchError>()
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  usePrivateSubmissionGuard({ model: plan.jobs[0]?.model ?? '', quantity: 1 })
  const current = currentNodeBatch(canvas.doc, editor, ids)
  const changed = current.signature !== plan.signature
  const close = () => {
    controller.current?.abort()
    onClose()
  }
  const start = async () => {
    if (controller.current || changed || plan.error || current.blocked) return
    const abort = new AbortController()
    controller.current = abort
    setStatus('running')
    try {
      await runNodeBatch(canvas.doc, editor, ids, plan, abort.signal, (count, id) => {
        setCompleted(count)
        setActive(id)
      })
      setStatus('done')
    } catch (error) {
      setFailure(error instanceof NodeBatchFailure ? error.code : 'failed')
      setStatus('error')
    }
  }
  const refresh = () => {
    controller.current = null
    setPlan(currentNodeBatch(canvas.doc, editor, ids))
    setFailure(undefined)
    setStatus('ready')
    setCompleted(0)
    setActive('')
  }
  const errors: Record<NodeBatchError, string> = {
    empty: t('nodeBatch.empty'),
    cycle: t('nodeBatch.cycle'),
    busy: t('nodeBatch.busy'),
    prompt: t('nodeBatch.prompt'),
    media: t('nodeBatch.media'),
    model: t('nodeBatch.model'),
    changed: t('nodeBatch.changed'),
    failed: t('nodeBatch.failed'),
    cancelled: t('nodeBatch.cancelled'),
    limit: t('nodeBatch.limit'),
    balance: t('nodeBatch.balance'),
  }
  return (
    <Dialog
      title={t('nodeBatch.title')}
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            {t(
              status === 'running'
                ? 'nodeBatch.stop'
                : status === 'ready'
                  ? 'storyboard.cancel'
                  : 'nodeBatch.close',
            )}
          </Button>
          {status === 'ready' && !changed && (
            <Button
              disabled={Boolean(plan.error) || current.blocked || !snapshot.nodes.length}
              onClick={() => void start()}
            >
              {t('nodeBatch.confirm')}
            </Button>
          )}
          {status === 'ready' && changed && (
            <Button onClick={refresh}>{t('nodeBatch.refresh')}</Button>
          )}
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        {t('nodeBatch.summary', { count: plan.jobs.length })}
      </p>
      <NodeBatchJobs
        jobs={plan.jobs}
        completed={completed}
        active={status === 'running' ? active : undefined}
      />
      {plan.credits !== undefined && (
        <p className="flex items-center justify-between gap-2 text-sm">
          <span>{t('nodes.estimatedCost')}</span>
          <Credits credits={plan.credits} />
        </p>
      )}
      {status === 'ready' && (changed || plan.error || current.blockedReason) && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {changed ? errors.changed : plan.error ? errors[plan.error] : current.blockedReason}
        </p>
      )}
      {status === 'running' && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {t('nodeBatch.progress', { done: completed, total: plan.jobs.length })}
        </p>
      )}
      {status === 'done' && (
        <p role="status" className="mt-3 text-sm text-success">
          {t('nodeBatch.done')}
        </p>
      )}
      {status === 'error' && failure && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {errors[failure]}
        </p>
      )}
    </Dialog>
  )
}
