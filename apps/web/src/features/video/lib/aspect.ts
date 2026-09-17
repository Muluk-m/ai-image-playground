import { i18next } from '../../../i18n'
import type { VideoTask } from '../types'

export function followsFirstFrameLabel(): string {
  return i18next.t('aspect.followsFirstFrame', { ns: 'video' })
}

type AspectFields = Pick<VideoTask, 'source' | 'aspectRatio' | 'width' | 'height'>

/** 图生输出跟随首帧比例，所选比例只是提交体里的占位，不能拿来当结果展示。 */
export function videoAspectLabel(task: AspectFields): string {
  if (task.width && task.height) return `${task.width}×${task.height}`
  return task.source === 'image' ? followsFirstFrameLabel() : task.aspectRatio
}

/** 缩略图画框的 CSS aspect-ratio；图生任务在拿到实际尺寸前交给图片自己撑。 */
export function videoFrameAspect(task: AspectFields): string | undefined {
  if (task.width && task.height) return `${task.width} / ${task.height}`
  return task.source === 'image' ? undefined : task.aspectRatio.replace(':', ' / ')
}
