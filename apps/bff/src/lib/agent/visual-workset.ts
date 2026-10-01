import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ImageContent, Message } from '@earendil-works/pi-ai'
import type { AgentVisualObservation } from '@image-playground/shared'
import { config } from '../../config'
import { AgentToolError } from './tools/errors'
import { visualEvidenceOf } from './visual-input'

function images(messages: readonly (AgentMessage | Message)[]): ImageContent[] {
  return messages.flatMap((message) =>
    (message.role === 'user' || message.role === 'toolResult') && Array.isArray(message.content)
      ? message.content.filter((block): block is ImageContent => block.type === 'image')
      : [],
  )
}

export function createVisualWorkset() {
  const active = new Set<ImageContent>()
  const delivered = new Map<string, Set<ImageContent>>()
  const released = new WeakMap<ImageContent, string>()
  let retained = new Set<string>()
  const admit = (
    blocks: readonly ImageContent[],
    removing: ReadonlySet<ImageContent> = new Set(),
  ) => {
    const candidate = new Set([...active].filter((block) => !removing.has(block)))
    for (const block of blocks) candidate.add(block)
    const bytes = [...candidate].reduce(
      (sum, block) => sum + Buffer.byteLength(JSON.stringify(block), 'utf8'),
      0,
    )
    const limit = config.operator.quotas['agent:request-max-bytes']
    if (!Number.isSafeInteger(limit) || limit < 1 || bytes > limit) {
      const ids = [
        ...new Set(
          blocks.flatMap((block) => {
            const identity = visualEvidenceOf(block)
            return identity ? [identity.imageId] : []
          }),
        ),
      ].join('、')
      throw new AgentToolError(
        'quota_exceeded',
        `视觉工作集需要 ${bytes} 字节，超过当前准备预算 ${limit}。本次图片 ${ids} 未送入模型，不代表已查看，联合比较尚未完成。请让用户选择缩小共同比较范围或指定必要区域；逐图摘要不能冒充完整联合比较。`,
      )
    }
    for (const block of removing) active.delete(block)
    for (const block of blocks) active.add(block)
  }
  return {
    admit,
    dispatched(messages: readonly Message[]) {
      for (const block of images(messages)) {
        const metadata = visualEvidenceOf(block)
        if (!metadata) continue
        const group = delivered.get(metadata.imageId) ?? new Set<ImageContent>()
        group.add(block)
        delivered.set(metadata.imageId, group)
      }
      return images(messages).flatMap((block) => {
        const metadata = visualEvidenceOf(block)
        return metadata ? [metadata] : []
      })
    },
    release(
      completed: readonly { imageId: string; observation: string }[],
      dependencies?: readonly string[],
      replacement: readonly ImageContent[] = [],
    ) {
      const protectedIds = dependencies ? new Set(dependencies) : retained
      // Validate the whole operation before releasing anything.
      const completing = new Set<string>()
      for (const { imageId, observation } of completed) {
        if (completing.has(imageId))
          throw new AgentToolError(
            'invalid_params',
            `图片 ${imageId} 在同一释放请求中重复；本次没有释放任何像素，请去重后重试。`,
          )
        completing.add(imageId)
        const blocks = delivered.get(imageId)
        if (!observation.trim() || !blocks?.size)
          throw new AgentToolError(
            'invalid_params',
            `图片 ${imageId} 尚未实际看过，不能记录完成结论或释放像素。请先用 viewImage 读取。`,
          )
        if (
          imageId.startsWith('tool:') ||
          protectedIds.has(imageId) ||
          [...blocks].some((block) => visualEvidenceOf(block)?.selection)
        )
          throw new AgentToolError(
            'invalid_params',
            `图片 ${imageId} 仍用于活动选区或联合比较，必须保留视觉证据。`,
          )
      }
      const removing = new Set(completed.flatMap(({ imageId }) => [...delivered.get(imageId)!]))
      admit(replacement, removing)
      retained = protectedIds
      const observations: AgentVisualObservation[] = []
      for (const { imageId, observation } of completed) {
        observations.push({
          imageId,
          observation,
          evidence: [...delivered.get(imageId)!].flatMap((block) => {
            const metadata = visualEvidenceOf(block)
            return metadata ? [metadata] : []
          }),
        })
        const note = `图片 ${imageId} 的像素已按完成声明移出；可用 viewImage 重读。已观察结论：${observation}`
        for (const block of delivered.get(imageId)!) {
          released.set(block, note)
          // The agent retains its original messages. Clear consumed buffers as well as its outbound view.
          block.data = ''
        }
        delivered.delete(imageId)
      }
      return observations
    },
    async transform(
      messages: AgentMessage[],
      compact: (messages: AgentMessage[]) => Promise<AgentMessage[]>,
    ) {
      const prepared = messages.map((message) => {
        if (
          (message.role !== 'user' && message.role !== 'toolResult') ||
          !Array.isArray(message.content)
        )
          return message
        return {
          ...message,
          content: message.content.map((block) => {
            const note = block.type === 'image' ? released.get(block) : undefined
            return note ? { type: 'text' as const, text: note } : block
          }),
        }
      })
      admit(images(prepared))
      const compacted = await compact(prepared)
      const remaining = new Set(images(compacted))
      // Text compaction cannot silently discard a comparison or a selection. The hard gate may refuse it.
      return images(prepared).every((block) => remaining.has(block)) ? compacted : prepared
    },
  }
}
export type VisualWorkset = ReturnType<typeof createVisualWorkset>
