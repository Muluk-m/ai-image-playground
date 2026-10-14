import Badge from '../../../components/patterns/Badge'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import type { NodeBatchJob } from '../lib/nodeBatch'

/** The proposal and final confirmation show the same model, quantity and node labels. */
export default function NodeBatchJobs({
  jobs,
  completed = 0,
  active,
}: {
  jobs: readonly NodeBatchJob[]
  completed?: number
  active?: string
}) {
  const { t } = useTranslation('canvas')
  return (
    <ol className="my-4 space-y-2">
      {jobs.map((job, index) => (
        <li
          key={job.id}
          className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm"
        >
          <span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
          <Icon name={job.kind === 'image' ? 'image' : 'video'} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="break-words">
              {job.label || t(job.kind === 'image' ? 'nodes.addImage' : 'nodes.addVideo')}
            </p>
            <p className="break-words text-xs text-muted-foreground">
              {job.model} · {job.quantity}
              {t(job.kind === 'image' ? 'nodeBatch.images' : 'nodeBatch.seconds')}
            </p>
          </div>
          {index < completed ? (
            <Badge tone="success">{t('nodeBatch.finished')}</Badge>
          ) : active === job.id ? (
            <Badge tone="primary">{t('nodeBatch.running')}</Badge>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
