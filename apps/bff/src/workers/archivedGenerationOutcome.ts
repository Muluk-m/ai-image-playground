import type { TaskErrorType } from '@image-playground/shared'
import type { GenerationMediaLink } from '../lib/generationMedia'

/**
 * 归档之后怎么收口。
 * candidate 本来就没有作品链接，完成并按出图结算，画布仍从队列读图。
 * 其他任务最后没有任何输出链接，按「上游没出图」失败，走现有的失败退款。
 * 原件中断仍用 upstream_result_unknown，那是可恢复的保存失败，不是没出图。
 */
export function archivedGenerationOutcome(input: {
  candidate: boolean
  missing: boolean
  media: readonly GenerationMediaLink[] | undefined
}):
  | { status: 'completed' }
  | {
      status: 'failed'
      errorType: Extract<TaskErrorType, 'upstream_no_image' | 'upstream_result_unknown'>
    } {
  if (input.missing) return { status: 'failed', errorType: 'upstream_result_unknown' }
  const outputLinks = input.media?.filter((link) => link.role === 'output').length
  if (!input.candidate && outputLinks === 0)
    return { status: 'failed', errorType: 'upstream_no_image' }
  return { status: 'completed' }
}
