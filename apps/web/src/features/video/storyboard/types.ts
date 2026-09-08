import type {
  StoryboardSeconds,
  StoryboardShot,
  StoryboardShotCount,
  VideoAspectRatio,
} from '@image-playground/shared'

/** 一镜的脚本加它在工作台里的三条产物。文案字段可编辑，任务 id 由生成流程写。 */
export type StoryboardShotRecord = StoryboardShot & {
  imageTaskId: string | null
  imageId: string | null
  videoTaskId: string | null
}

export interface StoryboardRecord {
  id: string
  createdAt: number
  updatedAt: number
  title: string
  summary: string
  idea: string
  aspectRatio: VideoAspectRatio
  secondsPerShot: StoryboardSeconds
  /** 重写脚本要照原样再问一次，所以风格跟着记录走，不跟着左栏。 */
  style: StoryboardStyle
  referenceImageId: string | null
  shots: StoryboardShotRecord[]
}

export const STORYBOARD_STYLES = ['写实', '杂志', '动画', '不限'] as const
export type StoryboardStyle = (typeof STORYBOARD_STYLES)[number]
export const STORYBOARD_FREE_STYLE: StoryboardStyle = '不限'

/** 左栏这一刻的分镜参数。 */
export interface StoryboardDraft {
  idea: string
  shots: StoryboardShotCount
  secondsPerShot: StoryboardSeconds
  style: StoryboardStyle
}

/** 比例与参考图跟着视频草稿走，提交时才和分镜草稿拼成一次请求。 */
export type StoryboardPlanInput = StoryboardDraft & {
  aspectRatio: VideoAspectRatio
  referenceImageId: string | null
}

export type StoryboardShotPatch = Partial<
  Pick<StoryboardShotRecord, 'title' | 'description' | 'camera' | 'line' | 'videoPrompt'>
>
