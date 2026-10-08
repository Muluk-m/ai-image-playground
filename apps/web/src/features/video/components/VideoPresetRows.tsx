import {
  canonicalVideoVoice,
  VIDEO_ASPECT_RATIOS,
  VIDEO_PRESET_VOICES,
  VIDEO_RESOLUTION_LABELS,
  type VideoModelSupport,
  type VideoPresetVoice,
  videoDurationsForResolution,
  videoRateMultiplier,
} from '@image-playground/shared'
import { SettingsChoice, SettingsSection } from '../../../components/composer/SettingsPanel'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { useTranslation } from '../../../i18n'
import { useVideoStore } from '../store'
import type { VideoDraft } from '../types'

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
  draft: Pick<VideoDraft, 'model' | 'duration' | 'aspectRatio' | 'resolution' | 'voices'>
  /** 图生时画幅跟着首帧走，这一行只读。 */
  aspectFollowsFirstFrame: boolean
}) {
  const { t } = useTranslation('video')
  const durations = videoDurationsForResolution(support, draft.resolution)
  return (
    <>
      <SettingsChoice
        label={t('composer.durationLabel')}
        options={support.durations}
        value={draft.duration}
        render={(duration) => t('shared.seconds', { seconds: duration })}
        optionDisabled={(duration) => !durations.includes(duration)}
        onChange={(duration) => useVideoStore.getState().setDuration(duration)}
      />
      <SettingsChoice
        label={t('field.aspectRatio')}
        options={VIDEO_ASPECT_RATIOS.filter((ratio) => support.aspectRatios.includes(ratio))}
        value={draft.aspectRatio}
        render={(ratio) => ratio}
        onChange={(ratio) => useVideoStore.getState().setAspectRatio(ratio)}
        disabled={aspectFollowsFirstFrame}
        note={aspectFollowsFirstFrame ? t('aspect.followsFirstFrame') : undefined}
      />
      <SettingsChoice
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
      <VoiceChoices support={support} draft={draft} />
    </>
  )
}

function voiceLabelKey(id: string): `voice.${VideoPresetVoice}` | null {
  const voice = canonicalVideoVoice(id)
  return voice ? `voice.${voice}` : null
}

function VoiceChoices({
  support,
  draft,
}: {
  support: VideoModelSupport
  draft: Pick<VideoDraft, 'voices'>
}) {
  const voices = support.voices
  const { t } = useTranslation('video')
  if (!voices) return null
  const selected = draft.voices ?? []
  const remaining = VIDEO_PRESET_VOICES.filter((id) => !selected.includes(id))
  const setVoices = (next: readonly string[]) => useVideoStore.getState().setVoices(next)
  return (
    <SettingsSection title={t('field.voices')}>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((id) => {
          const key = voiceLabelKey(id)
          const name = key ? t(key) : id
          return (
            <button
              key={id}
              type="button"
              aria-label={t('voice.remove', { name })}
              onClick={() => setVoices(selected.filter((one) => one !== id))}
              className="h-8 rounded-full bg-muted px-2.5 text-xs"
            >
              {name}
            </button>
          )
        })}
        {selected.length < voices.max && remaining.length > 0 && (
          <Select
            key={selected.join(',')}
            value=""
            onValueChange={(id) => setVoices([...selected, id])}
          >
            <SelectTrigger
              aria-label={t('field.voices')}
              className="h-8 w-auto gap-1.5 rounded-full border-0 bg-muted px-2.5 text-xs"
            >
              <SelectValue placeholder={t('voice.add')} />
            </SelectTrigger>
            <SelectContent>
              {remaining.map((id) => (
                <SelectItem key={id} value={id}>
                  {t(`voice.${id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </SettingsSection>
  )
}
