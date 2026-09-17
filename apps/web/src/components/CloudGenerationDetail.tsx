import type { GenerationDetail } from '@image-playground/shared'
import { RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n'
import { reuseCloudGeneration } from '../lib/reuseCloudGeneration'
import { Button } from './ui/button'

export default function CloudGenerationDetail({ detail }: { detail: GenerationDetail }) {
  const { t } = useTranslation('task')
  const controller = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'reuseFailed' | 'modelUnavailable' | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  async function reuse() {
    controller.current?.abort()
    const operation = new AbortController()
    controller.current = operation
    setBusy(true)
    setError(null)
    try {
      await reuseCloudGeneration(detail, operation.signal)
    } catch (cause) {
      if (!operation.signal.aborted)
        setError(
          cause instanceof Error && cause.message === 'model_unavailable'
            ? 'modelUnavailable'
            : 'reuseFailed',
        )
    } finally {
      if (!operation.signal.aborted) setBusy(false)
    }
  }
  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      <p className="whitespace-pre-wrap break-words text-sm">{detail.prompt}</p>
      <Button variant="outline" disabled={busy} onClick={() => void reuse()}>
        <RotateCcw size={16} />
        {t(busy ? 'cloudHistory.preparing' : 'cloudHistory.reuse')}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`cloudHistory.${error}`)}
        </p>
      )}
    </div>
  )
}
