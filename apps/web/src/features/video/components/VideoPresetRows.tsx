import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTION_LABELS,
  type VideoModelSupport,
  videoDurationsForResolution,
  videoRateMultiplier,
} from '@image-playground/shared'
import { useTranslation } from '../../../i18n'
import { useVideoStore } from '../store'
import type { VideoDraft } from '../types'
import ChipRow from './ChipRow'

/**
 * 时长、画幅、清晰度三行档位。画布生成栏与重新生成弹窗共用：两处写的是同一份草稿，
 * 联动（某清晰度只配部分时长）也只在这里写一次。
 */
export default function VideoPresetRows({
  support,
  draft,
  aspectFollowsFirstFrame,
}: {
  support: VideoModelSupport
  draft: Pick<VideoDraft, 'model' | 'duration' | 'aspectRatio' | 'resolution'>
  /** 图生时画幅跟着首帧走，这一行只读。 */
  aspectFollowsFirstFrame: boolean
}) {
  const { t } = useTranslation('video')
  const durations = videoDurationsForResolution(support, draft.resolution)
  return (
    <>
      <ChipRow
        label={t('composer.durationLabel')}
        options={support.durations}
        value={draft.duration}
        render={(duration) => t('shared.seconds', { seconds: duration })}
        optionDisabled={(duration) => !durations.includes(duration)}
        onChange={(duration) => useVideoStore.getState().setDuration(duration)}
      />
      <ChipRow
        label={t('field.aspectRatio')}
        options={VIDEO_ASPECT_RATIOS.filter((ratio) => support.aspectRatios.includes(ratio))}
        value={draft.aspectRatio}
        render={(ratio) => ratio}
        onChange={(ratio) => useVideoStore.getState().setAspectRatio(ratio)}
        disabled={aspectFollowsFirstFrame}
        note={aspectFollowsFirstFrame ? t('aspect.followsFirstFrame') : undefined}
      />
      <ChipRow
        label={t('field.resolution')}
        options={support.resolutions}
        value={draft.resolution}
        render={(resolution) => {
          const multiplier = videoRateMultiplier(draft.model, resolution)
          const label = VIDEO_RESOLUTION_LABELS[resolution]
          return multiplier === 1 ? label : `${label} ×${multiplier}`
        }}
        optionDisabled={(resolution) =>
          !videoDurationsForResolution(support, resolution).includes(draft.duration)
        }
        onChange={(resolution) => useVideoStore.getState().setResolution(resolution)}
      />
    </>
  )
}
