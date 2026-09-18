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
import VideoPresetRows from '../../video/components/VideoPresetRows'
import { useVideoStore } from '../../video/store'

/**
 * 生成栏视频档的参数：模型，加导演台同一套时长 / 画幅 / 清晰度行。
 * 读写的是导演台那份草稿，两处不另养一份。
 */
export default function CanvasVideoParams({ hasFirstFrame }: { hasFirstFrame: boolean }) {
  const { t } = useTranslation('video')
  const draft = useVideoStore((state) => state.draft)
  const options = videoModelOptions()
  const option = options.find((one) => one.modelId === draft.model)

  useEffect(() => {
    useVideoStore.getState().syncModelOptions()
  }, [])

  if (!option) return null
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
      <VideoPresetRows
        support={option.support}
        draft={draft}
        aspectFollowsFirstFrame={hasFirstFrame}
      />
    </div>
  )
}
