import type { AgentMessageView, AgentToolImage, AgentTurnReference } from '@image-playground/shared'
import { db, schema } from '../../db/client'
import { resolveImageBytesRef } from '../extractImages'
import { objectStore } from '../objectStore'
import { asQueueProvider } from '../queueProvider'
import { readAssetImage } from '../sync-assets'
import { taskAccessWhere } from '../task-access'

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
}

interface TaskOutput {
  readonly taskId: string
  readonly outputIndex: number
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return `data:${mime};base64,${view.toString('base64')}`
}

async function readTaskOutput(
  output: TaskOutput,
  userId: string | null,
): Promise<ResolvedAgentImage | null> {
  const [task] = await db
    .select({
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      result_payload: schema.tasks.result_payload,
    })
    .from(schema.tasks)
    .where(taskAccessWhere(output.taskId, userId))
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

/** 附在用户消息后面送给模型；没有引用时是空串。 */
export function referenceManifest(references: readonly AgentTurnReference[]): string {
  if (references.length === 0) return ''
  const lines = references.map((one, at) => {
    const name = one.name ? `${one.name}，` : ''
    const mask = one.maskDataUrl ? '，用户在上面画了遮罩' : ''
    return `[image ${at + 1}] ${name}图片 id ${one.imageId}${mask}`
  })
  return `\n\n本轮引用的图：\n${lines.join('\n')}`
}

export function createAgentImageSource(input: {
  readonly references: readonly AgentTurnReference[]
  readonly history: readonly AgentMessageView[]
  readonly userId: string | null
}): AgentImageSource {
  const { userId } = input
  const references = new Map(input.references.map((one) => [one.imageId, one]))
  const outputs = outputsFromHistory(input.history)
  // 缓存 promise 而不是值：模型连着改同一张图时，重复的那几次连 I/O 都不发。
  const resolving = new Map<string, Promise<ResolvedAgentImage | null>>()

  const read = async (imageId: string): Promise<ResolvedAgentImage | null> => {
    const reference = references.get(imageId)
    if (reference) {
      return {
        dataUrl: reference.dataUrl,
        ...(reference.maskDataUrl ? { maskDataUrl: reference.maskDataUrl } : {}),
      }
    }
    const output = outputs.get(imageId)
    if (output) return readTaskOutput(output, userId)
    if (!userId) return null
    const asset = await readAssetImage(userId, imageId)
    return asset ? { dataUrl: dataUrl(asset.bytes, asset.contentType) } : null
  }

  return {
    note(images) {
      for (const image of images) {
        outputs.set(image.imageId, { taskId: image.taskId, outputIndex: image.outputIndex })
      }
    },

    resolve(imageId) {
      const running = resolving.get(imageId)
      if (running) return running
      const started = read(imageId)
      resolving.set(imageId, started)
      return started
    },
  }
}
