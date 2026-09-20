import type {
  AgentMessageView,
  AgentMode,
  AgentToolResultBlock,
  AgentTurnParams,
} from '@image-playground/shared'
import { agentTextFromBlocks, agentToolResultSummary } from '@image-playground/shared'

/**
 * 唤醒轮送给模型的那一份：它不是用户说的话，不落库、不出气泡，只在这一轮的模型输入里。
 * 结果本身已经结算进了对话记录（见 `background-jobs.ts`），这里只点名「是哪几个、该做什么」，
 * 并把要复核的产物作为视觉证据附上。
 */

export interface WakeJob {
  readonly messageId: string
  readonly block: AgentToolResultBlock
}

/** 唤醒点名的那几个任务在对话记录里的结果块；读回历史时它们已经结算成终局。 */
export function wakeJobs(
  history: readonly AgentMessageView[],
  taskIds: readonly string[],
): WakeJob[] {
  const wanted = new Set(taskIds)
  return history.flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === 'toolResult' && block.job && wanted.has(block.job.taskId)
        ? [{ messageId: message.id, block }]
        : [],
    ),
  )
}

/** 唤醒轮沿用提交时那次调用的创作类型与参数：用户当时在参数浮层里选的，这一轮照旧。 */
export function wakeTurnSetup(jobs: readonly WakeJob[]): {
  readonly mode: AgentMode
  readonly params?: AgentTurnParams
} {
  const snapshot = jobs.find((job) => job.block.snapshot)?.block.snapshot
  const video = jobs.some((job) => job.block.job?.media === 'video')
  return {
    mode: snapshot?.mode ?? (video ? 'video' : 'image'),
    ...(snapshot?.params ? { params: snapshot.params } : {}),
  }
}

/** 要复核的图片产物：只有成功的才有，视频取不出可看的位图。 */
export function wakeReviewImageIds(jobs: readonly WakeJob[]): string[] {
  return jobs.flatMap((job) =>
    job.block.status === 'succeeded'
      ? (job.block.artifacts ?? [])
          .filter((artifact) => artifact.media === 'image')
          .map((artifact) => artifact.artifactId)
      : [],
  )
}

/**
 * 授权原文取提交这一批的那一轮用户原话：局部改图的复核与预先列明的后续编辑，都按用户当时
 * 说的核对，而不是按这段系统说明。
 */
export function wakeAuthorizationPrompt(
  history: readonly AgentMessageView[],
  submittingTurnId: string,
): string {
  const asked = history.find(
    (message) => message.role === 'user' && message.turnId === submittingTurnId,
  )
  return asked ? agentTextFromBlocks(asked.content) : ''
}

const REVIEW_LINE =
  '需要复核的任务：产物已作为视觉证据附在下面。按上面每条结果里的「执行提示词」检查效果（局部改图看选区内的修改与边缘）——那是用户在确认卡上最终定下的指令，他可能亲手改过；它与更早的原话冲突时一律以它为准，不要拿旧要求去纠正已经被用户改掉的地方。如实说明是否达到要求；不满意就说明问题并提议怎么改，不要自行付费重新提交。'

/**
 * 首次改图预先列明的后续编辑只有单独的唤醒轮能接着做：那一轮带着原来的计划与提交时的授权原文。
 * 并进用户消息的那一轮没有这份计划，授权换成了用户的新话，门禁会拒掉这些后续编辑。
 */
const DEFERRED_LINE = '首次改图时预先列明的后续编辑（deferredEdits）可以用这些产物继续执行。'

export function wakeTurnPrompt(jobs: readonly WakeJob[]): string {
  return wakeResultLines(jobs, { continuePlan: true }).join('\n')
}

function wakeResultLines(
  jobs: readonly WakeJob[],
  { continuePlan }: { readonly continuePlan: boolean },
): string[] {
  const failed = jobs.filter((job) => job.block.status === 'failed')
  const reviewed = jobs.filter((job) => job.block.status === 'succeeded')
  const lines = [
    '（系统通知，不是用户说的话）你之前提交的后台任务有结果了：',
    ...jobs.map((job) => `- ${agentToolResultSummary(job.block)}`),
  ]
  if (failed.length > 0)
    lines.push(
      '失败的任务：用一两句话告诉用户哪一项没做成、原因是什么，并提议下一步（例如换个说法、稍后再试）。不要自行付费重新提交，等用户决定。',
    )
  if (reviewed.length > 0) lines.push(continuePlan ? `${REVIEW_LINE}${DEFERRED_LINE}` : REVIEW_LINE)
  lines.push('产物已经自动放在用户的画布上，不要让用户自己去保存。')
  return lines
}

/**
 * 唤醒并进用户消息的那一轮时，跟在用户原话后面的那段说明：用户的话优先，结果顺带交代。
 * 它同样不落库，只进这一轮的模型输入。这一轮不带提交时的改图计划，所以不提议接着做预先列明的
 * 后续编辑，而是明说按用户的新话来。
 */
export function mergedWakePrompt(jobs: readonly WakeJob[]): string {
  const reviewed = jobs.some((job) => job.block.status === 'succeeded')
  return [
    ...wakeResultLines(jobs, { continuePlan: false }),
    '用户刚好也说了话（就是上面那条）：先回应用户这条消息，再顺带交代这些结果。',
    ...(reviewed
      ? [
          '之前改图时预先列明的后续编辑（deferredEdits）这一轮不要接着做：按用户这条新消息行事，用户想继续的话会自己说。',
        ]
      : []),
  ].join('\n')
}
