import { VIDEO_RESOLUTION_LABELS } from '@image-playground/shared'
import { type ReactNode, useEffect } from 'react'
import { Hint } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import {
  type ComposerControlSize,
  composerModelChipClass,
  RatioShape,
  SettingsPopover,
} from '../../../components/composer/SettingsPanel'
import { ModelLogo } from '../../../components/ModelIdentity'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { useTranslation } from '../../../i18n'
import { videoModelOptions } from '../../../lib/channels/videoChannels'
import VideoPresetRows from '../../video/components/VideoPresetRows'
import { useVideoStore } from '../../video/store'

/**
 * 生成栏视频档的参数：和图片档同一套长相——模型单独一个 chip，时长 / 画幅 / 清晰度收进「视频设置」卡片。
 * 读写的是画布共用的视频参数草稿，不另养一份。
 */
export default function CanvasVideoParams({
  hasFirstFrame,
  size = 'md',
  children,
}: {
  hasFirstFrame: boolean
  size?: ComposerControlSize
  children?: ReactNode
}) {
  const { t } = useTranslation('video')
  const draft = useVideoStore((state) => state.draft)
  const options = videoModelOptions()
  const option = options.find((one) => one.modelId === draft.model)

  useEffect(() => {
    useVideoStore.getState().syncModelOptions()
  }, [])

  if (!option) return null
  const summary = [
    t('shared.seconds', { seconds: draft.duration }),
    hasFirstFrame ? undefined : draft.aspectRatio,
    VIDEO_RESOLUTION_LABELS[draft.resolution],
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <Select
        value={draft.model}
        onValueChange={(model) => useVideoStore.getState().setModel(model)}
      >
        <Hint tooltip={`${t('field.model')}：${option.label}`}>
          <SelectTrigger aria-label={t('field.model')} className={composerModelChipClass(size)}>
            <SelectValue>
              <span className="creation-model-value">
                <ModelLogo model={option.modelId} />
                <span className="creation-model-name">{option.label}</span>
              </span>
            </SelectValue>
          </SelectTrigger>
        </Hint>
        <SelectContent className="max-w-[calc(100vw-24px)]">
          {options.map((one) => (
            <SelectItem key={one.modelId} value={one.modelId}>
              <span className="flex items-center gap-2 whitespace-normal break-words">
                <ModelLogo model={one.modelId} />
                {one.label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SettingsPopover
        title={t('settings.title')}
        summary={summary}
        size={size}
        icon={
          <RatioShape ratio={hasFirstFrame ? 'auto' : draft.aspectRatio} className="h-3.5 w-3.5" />
        }
      >
        {() => (
          <>
            <VideoPresetRows
              support={option.support}
              draft={draft}
              aspectFollowsFirstFrame={hasFirstFrame}
            />
            {children}
          </>
        )}
      </SettingsPopover>
    </>
  )
}
