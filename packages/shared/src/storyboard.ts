import type { VideoAspectRatio, VideoDuration } from './video-presets'

export const STORYBOARD_SHOT_COUNTS = [2, 3, 4, 5] as const
export type StoryboardShotCount = (typeof STORYBOARD_SHOT_COUNTS)[number]

/** 整条分镜一次生成，总时长直接进视频请求，所以只能取 `VideoDuration` 里的档位。 */
export const STORYBOARD_TOTAL_SECONDS = [10, 15] as const satisfies readonly VideoDuration[]
export type StoryboardTotalSeconds = (typeof STORYBOARD_TOTAL_SECONDS)[number]

export const STORYBOARD_IDEA_MAX_CHARS = 2000
export const STORYBOARD_STYLE_MAX_CHARS = 100
export const STORYBOARD_MAX_REFERENCE_IMAGES = 4

export interface StoryboardSegment {
  readonly startSeconds: number
  readonly seconds: number
}

/** 均分总时长：端点对齐到 0.5 秒，段与段首尾相接，秒数之和等于总时长。 */
export function storyboardSegments(totalSeconds: number, shots: number): StoryboardSegment[] {
  const marks = Array.from(
    { length: shots + 1 },
    (_, index) => Math.round((totalSeconds * index * 2) / shots) / 2,
  )
  return marks.slice(0, -1).map((startSeconds, index) => ({
    startSeconds,
    seconds: marks[index + 1]! - startSeconds,
  }))
}

/** 时间段标签的数字部分，如 `0-3.5`。 */
export function storyboardRangeLabel(segment: StoryboardSegment): string {
  return `${segment.startSeconds}-${segment.startSeconds + segment.seconds}`
}

/** 整条视频提示词里每镜那一行的行首，模型照它写，旧记录也照它补。 */
export function storyboardShotLabel(no: number, segment: StoryboardSegment): string {
  return `镜头${no}（${storyboardRangeLabel(segment)}秒）`
}

export interface StoryboardShot extends StoryboardSegment {
  /** 1-based 镜号 */
  readonly no: number
  readonly title: string
  readonly description: string
  readonly camera: string
  /** 台词 / 字幕；默片式镜头没有词，允许空串。 */
  readonly line: string
  readonly imagePrompt: string
  readonly videoPrompt: string
}

export interface StoryboardPlan {
  readonly title: string
  readonly summary: string
  /** 整条视频的提示词：首行定主体 / 场景 / 风格 / 光线，其后每镜一行时间段。 */
  readonly videoPrompt: string
  readonly shots: readonly StoryboardShot[]
}

export interface StoryboardPlanRequest {
  readonly idea: string
  readonly shots: StoryboardShotCount
  readonly totalSeconds: StoryboardTotalSeconds
  readonly aspectRatio: VideoAspectRatio
  readonly style?: string
  readonly referenceImages?: readonly string[]
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseShot(value: unknown, no: number, segment: StoryboardSegment): StoryboardShot | null {
  if (typeof value !== 'object' || value === null) return null
  const shot = value as Record<string, unknown>
  if (shot.no !== no) return null

  const title = trimmed(shot.title)
  const description = trimmed(shot.description)
  const camera = trimmed(shot.camera)
  const imagePrompt = trimmed(shot.imagePrompt)
  const videoPrompt = trimmed(shot.videoPrompt)
  if (!title || !description || !camera || !imagePrompt || !videoPrompt) return null

  return {
    no,
    title,
    description,
    camera,
    line: typeof shot.line === 'string' ? shot.line.trim() : '',
    // 时间段是请求参数不是模型答案：模型改了它，下游的视频请求就会跟界面对不上。
    ...segment,
    imagePrompt,
    videoPrompt,
  }
}

/** 模型给的分镜 JSON 与 BFF 应答是同一个形状，两侧共用这一个解析器。 */
export function parseStoryboardPlan(
  value: unknown,
  expected: { shots: number; totalSeconds: number },
): StoryboardPlan | null {
  if (typeof value !== 'object' || value === null) return null
  const { title, summary, videoPrompt, shots } = value as Record<string, unknown>

  const planTitle = trimmed(title)
  const planSummary = trimmed(summary)
  const planVideoPrompt = trimmed(videoPrompt)
  if (!planTitle || !planSummary || !planVideoPrompt) return null
  if (!Array.isArray(shots) || shots.length !== expected.shots) return null

  const segments = storyboardSegments(expected.totalSeconds, expected.shots)
  const parsed: StoryboardShot[] = []
  for (const [index, shot] of shots.entries()) {
    const one = parseShot(shot, index + 1, segments[index]!)
    if (!one) return null
    parsed.push(one)
  }
  return { title: planTitle, summary: planSummary, videoPrompt: planVideoPrompt, shots: parsed }
}
