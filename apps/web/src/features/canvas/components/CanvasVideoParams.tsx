import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTION_LABELS,
  videoDurationsForResolution,
  videoRateMultiplier,
} from '@image-playground/shared'
import { useEffect } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { useTranslation } from '../../../i18n'
import { videoModelOptions } from '../../../lib/channels/videoChannels'
import ChipRow from '../../video/components/ChipRow'
import { useVideoStore } from '../../video/store'

/**
 * 生成栏视频档的参数：模型、时长、画幅、清晰度。读写的是导演台那份草稿，
 * 两处选项与联动（某清晰度只配部分时长）同源，不另养一份。
 */
export default function CanvasVideoParams({ hasFirstFrame }: { hasFirstFrame: boolean }) {
  const { t } = useTranslation(['video', 'canvas'])
  const draft = useVideoStore((state) => state.draft)
  const options = videoModelOptions()
  const option = options.find((one) => one.modelId === draft.model)

  useEffect(() => {
    useVideoStore.getState().syncModelOptions()
  }, [])

  if (!option) return null
  const { support } = option
  const durations = videoDurationsForResolution(support, draft.resolution)

  return (
    <div className="flex flex-col gap-2 px-2">
      <Select
        value={draft.model}
        onValueChange={(model) => useVideoStore.getState().setModel(model)}
      >
        <SelectTrigger
          aria-label={t('field.model')}
          className="h-8 w-auto gap-1.5 self-start rounded-full border-0 bg-muted px-2.5 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((one) => (
            <SelectItem key={one.modelId} value={one.modelId}>
              {one.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
        disabled={hasFirstFrame}
        note={hasFirstFrame ? t('aspect.followsFirstFrame') : undefined}
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
    </div>
  )
}
