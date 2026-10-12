import type { AgentClarificationBlock, AgentMessageView } from '@image-playground/shared'
import { AgentToolError } from './tools/errors'

type Combination = NonNullable<AgentClarificationBlock['imageCombination']>

function question(combination: Combination): AgentClarificationBlock {
  const count = combination.referenceImageIds.length
  return {
    type: 'clarification',
    question: '这些新图要分别套用原图，还是共同用于一张结果？其他已说明的要求继续保留。',
    options: [
      `分别套用：每张新图各配原图，生成${count}张独立图片`,
      `共同参考：所有新图一起配原图，生成1张图片`,
    ],
    imageCombination: combination,
  }
}

/**
 * 同一底图原先只配一张参考，续作却把多张新图合并时，不能把一次颜色等澄清当成组合授权。
 * 只核对这种可从实际调用识别的变化，不凭图片数量推断所有多图任务都应逐张执行。
 */
export function createImageCombinationGuard(input: {
  readonly history: readonly AgentMessageView[]
  readonly references: readonly { readonly imageId: string }[]
  readonly text: string
  readonly hasNewReferences: boolean
}) {
  let pending: AgentClarificationBlock | undefined
  let approved: { combination: Combination; separate: boolean } | undefined
  const replies = []
  for (const message of [...input.history].reverse()) {
    if (message.role === 'user') break
    replies.push(message)
  }
  const asked = replies
    .flatMap((message) => message.content)
    .find((block) => block.type === 'clarification' && block.imageCombination)
  if (asked?.type === 'clarification' && asked.imageCombination && !input.hasNewReferences) {
    const expected = question(asked.imageCombination)
    const choice = expected.options.indexOf(input.text.trim())
    if (choice >= 0) approved = { combination: asked.imageCombination, separate: choice === 0 }
  }

  const attached = new Set(input.references.map((reference) => reference.imageId))
  const completed = new Set<string>()
  const previousEdits = input.history
    .flatMap((message) =>
      message.content.flatMap((block) =>
        block.type === 'toolResult' &&
        block.toolName === 'editImage' &&
        block.job &&
        (block.status === 'succeeded' || block.status === 'submitted') &&
        block.snapshot?.imageIds
          ? [block.snapshot.imageIds]
          : [],
      ),
    )
    .reverse()

  return {
    inspect(ids: readonly string[], n = 1): AgentClarificationBlock | undefined {
      if (pending) return pending
      if (approved) {
        const { referenceImageIds } = approved.combination
        const allowed = new Set(referenceImageIds)
        const matches = ids.slice(1).filter((id) => allowed.has(id))
        const valid = approved.separate
          ? ids.length === 2 && matches.length === 1
          : ids.length === referenceImageIds.length + 1 &&
            ids.slice(1).every((id, index) => id === referenceImageIds[index])
        if (!valid || ids[0] !== approved.combination.targetImageId)
          throw new AgentToolError(
            'invalid_params',
            approved.separate
              ? `用户已选择分别生成。每次只传 [${approved.combination.targetImageId}, 一张新图]，分别处理这些图片：${referenceImageIds.join('、')}。不可合并或省略。`
              : `用户已选择共同参考。请按顺序传入：${[approved.combination.targetImageId, ...referenceImageIds].join('、')}。`,
          )
        if (n !== 1)
          throw new AgentToolError('invalid_params', '本次确认每个组合只生成1张，不可增加版本数。')
        if (completed.has(JSON.stringify(ids)))
          throw new AgentToolError('invalid_params', '这个已确认组合已经拟稿或提交，不可重复生成。')
        return undefined
      }
      const previous = previousEdits.find((edit) => edit[0] === ids[0])
      const fresh = [
        ...new Set(ids.slice(1).filter((id) => attached.has(id) && !previous?.includes(id))),
      ]
      if (!previous || previous.length !== 2 || fresh.length < 2) return undefined
      pending = question({ targetImageId: ids[0]!, referenceImageIds: fresh })
      return pending
    },
    submitted(ids: readonly string[]) {
      if (approved) completed.add(JSON.stringify(ids))
    },
  }
}

export type ImageCombinationGuard = ReturnType<typeof createImageCombinationGuard>
