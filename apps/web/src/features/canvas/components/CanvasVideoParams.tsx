import { VIDEO_RESOLUTION_LABELS, type VideoModelSupport } from '@image-playground/shared'
import { type ReactNode, useEffect } from 'react'
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
import type { VideoDraft } from '../../video/types'

/**
 * 生成栏视频档的参数：和图片档同一套长相——模型单独一个 chip，时长 / 画幅 / 清晰度收进「视频设置」卡片。
 * 默认使用画布共用草稿；节点传 controlled 时保留各自参数。
 */
export default function CanvasVideoParams({
  hasFirstFrame,
  size = 'md',
  children,
  controlled,
}: {
  hasFirstFrame: boolean
  size?: ComposerControlSize
  children?: ReactNode
  controlled?: {
    draft: VideoDraft
    onChange: (patch: Partial<VideoDraft>) => void
    support?: VideoModelSupport
  }
}) {
  const { t } = useTranslation('video')
  const globalDraft = useVideoStore((state) => state.draft)
  const draft = controlled?.draft ?? globalDraft
  const options = videoModelOptions()
  const option = options.find((one) => one.modelId === draft.model)

  const isControlled = Boolean(controlled)
  useEffect(() => {
    if (!isControlled) useVideoStore.getState().syncModelOptions()
  }, [isControlled])

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
        onValueChange={(model) =>
          controlled ? controlled.onChange({ model }) : useVideoStore.getState().setModel(model)
        }
      >
        <SelectTrigger aria-label={t('field.model')} className={composerModelChipClass(size)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((one) => (
            <SelectItem key={one.modelId} value={one.modelId}>
              <span className="flex items-center gap-2">
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
              support={controlled?.support ?? option.support}
              draft={draft}
              onChange={controlled?.onChange}
              aspectFollowsFirstFrame={hasFirstFrame}
            />
            {children}
          </>
        )}
      </SettingsPopover>
    </>
  )
}
