import {
  VIDEO_MODEL_SUPPORT,
  type VideoGenerationRecord,
  videoRateMultiplier,
} from '@image-playground/shared'
import Credits from '../../../components/Credits'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'

export function AgentVideoDetails({ video }: { video: VideoGenerationRecord }) {
  const { t } = useTranslation('agent')
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      aria-label={t('video.parameters')}
    >
      <span>{VIDEO_MODEL_SUPPORT[video.model]?.label ?? video.model}</span>
      <span>{t('video.seconds', { count: video.duration })}</span>
      <span>{video.resolution}</span>
      <span>{video.aspectRatio}</span>
      {video.firstFrameId && <span>{t('video.firstFrame')}</span>}
      {video.lastFrameId && <span>{t('video.lastFrame')}</span>}
      {!!video.referenceIds?.length && (
        <span>{t('video.references', { count: video.referenceIds.length })}</span>
      )}
    </div>
  )
}

export function AgentVideoEstimate({ video }: { video: VideoGenerationRecord }) {
  const { t } = useTranslation('agent')
  const guard = usePrivateSubmissionGuard({
    model: video.model,
    quantity: video.duration,
    unitMultiplier: videoRateMultiplier(video.model, video.resolution),
  })
  return guard.estimatedCredits === undefined ? null : (
    <p className="text-xs text-muted-foreground">
      {t('video.estimatedCost')} <Credits credits={guard.estimatedCredits} />
    </p>
  )
}
