import type { AgentMessageView, AgentToolImage, AgentTurnReference } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { resolveImageBytesRef } from '../extractImages'
import { objectStore } from '../objectStore'
import { asQueueProvider } from '../queueProvider'
import { readAssetImage } from '../sync-assets'

export interface ResolvedAgentImage {
  readonly dataUrl: string
  /** 用户在这张图上画的遮罩，只有输入框附上的参考图才可能有。 */
  readonly maskDataUrl?: string
}

/** 模型只会说图片 id，字节从哪来由这里决定。 */
export interface AgentImageSource {
  resolve(imageId: string): Promise<ResolvedAgentImage | null>
  /** 记下工具刚产出的图，同一轮里下一个工具才能接着改它。 */
  note(images: readonly AgentToolImage[]): void
  /** 附在用户消息后面送给模型的参考图清单；没有引用时是空串。 */
  manifest(): string
}

interface TaskOutput {
  readonly taskId: string
  readonly outputIndex: number
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

async function readTaskOutput(output: TaskOutput): Promise<ResolvedAgentImage | null> {
  const [task] = await db
    .select({
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      result_payload: schema.tasks.result_payload,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, output.taskId))
    .limit(1)
  if (!task || task.status !== 'completed') return null
  const provider = asQueueProvider(task.provider)
  if (!provider) return null
  const ref = resolveImageBytesRef(provider, task.result_payload, output.outputIndex)
  if (!ref) return null
  if (ref.kind === 'b64') return { dataUrl: `data:${ref.mime};base64,${ref.data}` }
  if (ref.kind === 'object')
    return { dataUrl: dataUrl(await objectStore().read(ref.data), ref.mime) }
  const upstream = await fetch(ref.data)
  if (!upstream.ok) return null
  const mime = upstream.headers.get('content-type') ?? ref.mime
  return { dataUrl: dataUrl(new Uint8Array(await upstream.arrayBuffer()), mime) }
}

/** 历史里的工具结果块记着每张产出图的任务与下标，所以产物不必另立一张表。 */
function outputsFromHistory(history: readonly AgentMessageView[]): Map<string, TaskOutput> {
  const outputs = new Map<string, TaskOutput>()
  for (const message of history) {
    for (const block of message.content) {
      if (block.type !== 'toolResult') continue
      for (const image of block.images ?? []) {
        outputs.set(image.imageId, { taskId: image.taskId, outputIndex: image.outputIndex })
      }
    }
  }
  return outputs
}

export function createAgentImageSource(input: {
  readonly references: readonly AgentTurnReference[]
  readonly history: readonly AgentMessageView[]
  readonly userId: string | null
}): AgentImageSource {
  const references = new Map(input.references.map((one) => [one.imageId, one]))
  const outputs = outputsFromHistory(input.history)

  return {
    note(images) {
      for (const image of images) {
        outputs.set(image.imageId, { taskId: image.taskId, outputIndex: image.outputIndex })
      }
    },

    async resolve(imageId) {
      const reference = references.get(imageId)
      if (reference) {
        return {
          dataUrl: reference.dataUrl,
          ...(reference.maskDataUrl ? { maskDataUrl: reference.maskDataUrl } : {}),
        }
      }
      const output = outputs.get(imageId)
      if (output) return readTaskOutput(output)
      if (!input.userId) return null
      const asset = await readAssetImage(input.userId, imageId)
      return asset ? { dataUrl: dataUrl(asset.bytes, asset.contentType) } : null
    },

    manifest() {
      if (input.references.length === 0) return ''
      const lines = input.references.map((one, at) => {
        const name = one.name ? `${one.name}，` : ''
        const mask = one.maskDataUrl ? '，用户在上面画了遮罩' : ''
        return `[image ${at + 1}] ${name}图片 id ${one.imageId}${mask}`
      })
      return `\n\n本轮引用的图：\n${lines.join('\n')}`
    },
  }
}
