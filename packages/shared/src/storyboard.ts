import type { VideoAspectRatio, VideoDuration } from './video-presets'

export const STORYBOARD_SHOT_COUNTS = [2, 3, 4, 6] as const
export type StoryboardShotCount = (typeof STORYBOARD_SHOT_COUNTS)[number]

/** 每镜时长直接进 2.1 的视频请求，所以只能取 `VideoDuration` 里的档位。 */
export const STORYBOARD_SECONDS = [5, 8] as const satisfies readonly VideoDuration[]
export type StoryboardSeconds = (typeof STORYBOARD_SECONDS)[number]

export const STORYBOARD_IDEA_MAX_CHARS = 2000
export const STORYBOARD_STYLE_MAX_CHARS = 100

export interface StoryboardShot {
  /** 1-based 镜号 */
  readonly no: number
  readonly title: string
  readonly description: string
  readonly camera: string
  /** 台词 / 字幕；默片式镜头没有词，允许空串。 */
  readonly line: string
  readonly seconds: number
  readonly imagePrompt: string
  readonly videoPrompt: string
}

export interface StoryboardPlan {
  readonly title: string
  readonly summary: string
  readonly shots: readonly StoryboardShot[]
}

export interface StoryboardPlanRequest {
  readonly idea: string
  readonly shots: StoryboardShotCount
  readonly secondsPerShot: StoryboardSeconds
  readonly aspectRatio: VideoAspectRatio
  readonly style?: string
  readonly referenceImage?: string
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseShot(value: unknown, no: number, seconds: number): StoryboardShot | null {
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
    // 时长是请求参数不是模型答案：模型改了它，下游的视频请求就会跟界面对不上。
    seconds,
    imagePrompt,
    videoPrompt,
  }
}

/** 模型给的分镜 JSON 与 BFF 应答是同一个形状，两侧共用这一个解析器。 */
export function parseStoryboardPlan(
  value: unknown,
  expected: { shots: number; seconds: number },
): StoryboardPlan | null {
  if (typeof value !== 'object' || value === null) return null
  const { title, summary, shots } = value as Record<string, unknown>

  const planTitle = trimmed(title)
  const planSummary = trimmed(summary)
  if (!planTitle || !planSummary) return null
  if (!Array.isArray(shots) || shots.length !== expected.shots) return null

  const parsed: StoryboardShot[] = []
  for (const [index, shot] of shots.entries()) {
    const one = parseShot(shot, index + 1, expected.seconds)
    if (!one) return null
    parsed.push(one)
  }
  return { title: planTitle, summary: planSummary, shots: parsed }
}
