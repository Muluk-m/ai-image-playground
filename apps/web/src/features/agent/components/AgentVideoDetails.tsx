import {
  VIDEO_MODEL_SUPPORT,
  type VideoGenerationRecord,
  videoRateMultiplier,
} from '@image-playground/shared'
import {
  AudioLines,
  Clock3,
  Film,
  Images,
  type LucideIcon,
  Monitor,
  Ratio,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import type { ReactNode } from 'react'
import Credits from '../../../components/Credits'
import { ModelLogo } from '../../../components/ModelIdentity'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'

function VideoDetail({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon
  label: string
  children?: ReactNode
}) {
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-1"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {children}
    </span>
  )
}

export function AgentVideoDetails({ video }: { video: VideoGenerationRecord }) {
  const { t } = useTranslation(['agent', 'video'])
  const model = VIDEO_MODEL_SUPPORT[video.model]?.label ?? video.model
  return (
    <div
      className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      aria-label={t('agent:video.parameters')}
    >
      <span
        title={model}
        className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-1"
      >
        <ModelLogo model={video.model} />
        {model}
      </span>
      <VideoDetail icon={Clock3} label={t('agent:video.seconds', { count: video.duration })}>
        {t('agent:video.seconds', { count: video.duration })}
      </VideoDetail>
      <VideoDetail icon={Monitor} label={`${t('video:field.resolution')} ${video.resolution}`}>
        {video.resolution}
      </VideoDetail>
      <VideoDetail icon={Ratio} label={`${t('video:field.aspectRatio')} ${video.aspectRatio}`}>
        {video.aspectRatio}
      </VideoDetail>
      {video.firstFrameId && <VideoDetail icon={SkipBack} label={t('agent:video.firstFrame')} />}
      {video.lastFrameId && <VideoDetail icon={SkipForward} label={t('agent:video.lastFrame')} />}
      {!!video.referenceIds?.length && (
        <VideoDetail
          icon={Images}
          label={t('agent:video.references', { count: video.referenceIds.length })}
        >
          {video.referenceIds.length}
        </VideoDetail>
      )}
      {!!video.keyframes?.length && (
        <VideoDetail
          icon={Film}
          label={t('agent:video.keyframes', { count: video.keyframes.length })}
        >
          {video.keyframes.length}
        </VideoDetail>
      )}
      {!!video.voices?.length && (
        <VideoDetail
          icon={AudioLines}
          label={t('agent:video.voices', { count: video.voices.length })}
        >
          {video.voices.length}
        </VideoDetail>
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
