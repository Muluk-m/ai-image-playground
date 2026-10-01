import type { AgentBatchItemExecution, AgentToolArtifact } from '@image-playground/shared'
import { Ban, CheckCircle2, Clock3, Image, Loader2, TriangleAlert } from 'lucide-react'
import { useRef, useState } from 'react'
import Credits from '../../../components/Credits'
import { ImagePreview } from '../../../components/Lightbox'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { accountScope } from '../../../lib/authScope'
import { previewArtifactBitmap } from '../lib/artifactSource'

export function AgentBatchItemStatus({ execution }: { execution?: AgentBatchItemExecution }) {
  const { t } = useTranslation('agent')
  const status = execution?.status ?? 'pending'
  const Icon =
    status === 'completed'
      ? CheckCircle2
      : status === 'failed' || status === 'reconciling'
        ? TriangleAlert
        : status === 'cancelled'
          ? Ban
          : status === 'in_progress'
            ? Loader2
            : Clock3
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1">
      <Icon aria-hidden className="h-3 w-3" />
      {t(`batch.itemStatus.${status}`)}
    </span>
  )
}

export default function AgentBatchItemResult({
  execution,
}: {
  execution?: AgentBatchItemExecution
}) {
  const { t } = useTranslation(['agent', 'errors'])
  const [preview, setPreview] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const loading = useRef(false)
  if (!execution) return null
  const show = async (artifact: AgentToolArtifact) => {
    if (loading.current) return
    loading.current = true
    const current = accountScope()
    setBusy(true)
    setFailed(false)
    try {
      const source = await previewArtifactBitmap(artifact)
      if (current()) {
        setPreview(source)
        setFailed(source === null)
      }
    } finally {
      loading.current = false
      if (current()) setBusy(false)
    }
  }
  return (
    <div className="grid gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span>{t('batch.actualCost')}</span>
        {execution.actualCredits === null ? (
          <span>{t('batch.chargeUnknown')}</span>
        ) : (
          <Credits credits={execution.actualCredits} />
        )}
      </div>
      {execution.artifacts?.length ? (
        <div className="flex flex-wrap gap-1">
          {execution.artifacts.map((artifact, index) => (
            <Button
              key={artifact.artifactId}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void show(artifact)}
            >
              <Image aria-hidden className="mr-1 h-3 w-3" />
              {t('batch.viewResult', { index: index + 1 })}
            </Button>
          ))}
        </div>
      ) : null}
      {failed && (
        <p role="alert" className="text-destructive">
          {t('errors:agentBatch.output_unavailable')}
        </p>
      )}
      {preview && <ImagePreview src={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}
