import type { CanvasSnapshot } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import Credits from '../../../components/Credits'
import Badge from '../../../components/patterns/Badge'
import Dialog from '../../../components/patterns/Dialog'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { useVideoStore } from '../../video/store'
import type { CanvasEditor } from '../lib/editor'
import {
  currentNodeBatch,
  type NodeBatchError,
  NodeBatchFailure,
  runNodeBatch,
} from '../lib/nodeBatch'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'

export default function NodeBatchDialog({
  canvas,
  editor,
  ids,
  snapshot,
  onClose,
}: {
  canvas: NodeCanvasDocument
  editor: CanvasEditor
  ids: readonly string[]
  snapshot: CanvasSnapshot
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  // Subscribe to settings as well as parent document updates so a visible quote never silently changes.
  useStore((state) => state.settings)
  useStore((state) => state.params)
  useVideoStore((state) => state.draft)
  const [plan, setPlan] = useState(() => currentNodeBatch(canvas.doc, editor, ids))
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
      <ol className="my-4 space-y-2">
        {plan.jobs.map((job, index) => (
          <li
            key={job.id}
            className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm"
          >
            <span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
            <Icon name={job.kind === 'image' ? 'image' : 'video'} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate">
                {job.label || t(job.kind === 'image' ? 'nodes.addImage' : 'nodes.addVideo')}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {job.model} · {job.quantity}
                {t(job.kind === 'image' ? 'nodeBatch.images' : 'nodeBatch.seconds')}
              </p>
            </div>
            {index < completed ? (
              <Badge tone="success">{t('nodeBatch.finished')}</Badge>
            ) : active === job.id && status === 'running' ? (
              <Badge tone="primary">{t('nodeBatch.running')}</Badge>
            ) : null}
          </li>
        ))}
      </ol>
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
