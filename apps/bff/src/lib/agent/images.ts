import type {
  AgentMessageView,
  AgentStoredReference,
  AgentToolArtifact,
  AgentTurnReference,
  StoredImageRef,
} from '@image-playground/shared'
import { db, schema } from '../../db/client'
import { type ImageBytesRef, resolveImageBytesRef } from '../extractImages'
import { archiveInputImages, hydrateInputImages } from '../imageArchive'
import { log } from '../logger'
import { objectStore } from '../objectStore'
import { asQueueProvider } from '../queueProvider'
import { readAssetImage } from '../sync-assets'
import { taskAccessWhere } from '../task-access'
import { toModelImageDataUrl } from './modelImage'

export type AgentImageReference = AgentTurnReference | AgentStoredReference

export interface ResolvedAgentImage {
  readonly imageId: string
  readonly dataUrl: string
  /** 用户在这张图上画的遮罩，只有输入框附上的参考图才可能有。 */
  readonly maskDataUrl?: string
}

/**
 * 一段模型可以指着说话的视频产出。**字节不进模型**——它只拿得到 id，取字节是工具的事。
 */
export interface ResolvedAgentVideo {
  readonly videoId: string
  readonly taskId: string
  readonly outputIndex: number
  readonly mime: string
  /** 成片字节。大到几十 MB 都在这一次调用里读完，调用方自己决定写去哪。 */
  read(): Promise<Uint8Array>
}

/**
 * 按 id 找一段视频的三种结局。**分开回答**：「没这个 id」与「有但取不出来」要让模型
 * 看到不同的话，前者是它记错了 id，后者是那一镜还没跑完或者不归这个用户。
 */
export type AgentVideoLookup =
  | { readonly kind: 'ready'; readonly video: ResolvedAgentVideo }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unavailable' }

/** 模型只会说图片 id，字节从哪来由这里决定。 */
export interface AgentImageSource {
  readonly references: readonly AgentImageReference[]
  /**
   * 这一轮是不是遮罩轮：当前这批引用里有没有用户画的遮罩。插话换掉引用后跟着变，
   * 「本轮存在用户选区」的判断只问这一处。
   */
  readonly masked: boolean
  /**
   * 模型说的那个 id 对应的真 id（把 `image 2` 这类编号翻回去），不读字节。
   * 工具起跑时要立刻把锚点告诉画布，那一刻等不起一次对象存储往返。
   */
  attach(references: readonly AgentTurnReference[]): void
  identify(imageId: string): string
  resolve(imageId: string): Promise<ResolvedAgentImage | null>
  /** 记下工具刚产出的图，同一轮里下一个工具才能接着改它。视频不进这里：它取不出可编辑的位图。 */
  note(artifacts: readonly AgentToolArtifact[]): void
  /** 这一轮模型指得到的视频产物 id，按产出顺序；回执里列给它看。 */
  readonly videoIds: readonly string[]
  /** 视频产物的字节出口。与图片并列，规则相同：模型说 id，取字节只此一处。 */
  resolveVideo(videoId: string): Promise<AgentVideoLookup>
}

/** 按 id 取图，取不到就抛。工具共用这一句：模型换个 id 重试是它唯一的出路。 */
export async function requireAgentImages(
  source: AgentImageSource,
  imageIds: readonly string[],
): Promise<ResolvedAgentImage[]> {
  const resolved = await Promise.all(imageIds.map((id) => source.resolve(id)))
  return resolved.map((image, at) => {
    if (!image) {
      const available = source.references.map((reference) => reference.imageId).join('、')
      throw new Error(
        `图片 ${imageIds[at]} 不可用。${available ? `可用参考图 id：${available}；请核对后重试。` : '当前会话没有可用参考图。'}`,
      )
    }
    return image
  })
}

interface TaskOutput {
  readonly taskId: string
  readonly outputIndex: number
}

interface VideoOutput extends TaskOutput {
  readonly mime: string
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return `data:${mime};base64,${view.toString('base64')}`
}

/** 画布可存 SVG、用户能拖进 AVIF，但对话和生图上游只接收几种位图；读取时转换也能修复历史会话。 */
async function modelImage(image: ResolvedAgentImage | null): Promise<ResolvedAgentImage | null> {
  if (!image) return image
  const normalized = await toModelImageDataUrl(image.dataUrl)
  return normalized === image.dataUrl ? image : { ...image, dataUrl: normalized }
}

/** 这条任务产出的第 n 件东西在哪；任务不存在、没跑完、不归这个用户都是 null。 */
async function resolveTaskOutputRef(
  output: TaskOutput,
  userId: string | null,
): Promise<ImageBytesRef | null> {
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
  return resolveImageBytesRef(provider, task.result_payload, output.outputIndex)
}

/** 三种落法（内联 base64 / 对象存储 / 上游地址）取字节只此一处，图片与视频共用。 */
async function readOutputBytes(ref: ImageBytesRef): Promise<{ bytes: Uint8Array; mime: string }> {
  if (ref.kind === 'b64') return { bytes: Buffer.from(ref.data, 'base64'), mime: ref.mime }
  if (ref.kind === 'object') return { bytes: await objectStore().read(ref.data), mime: ref.mime }
  const upstream = await fetch(ref.data)
  if (!upstream.ok) throw new Error(`上游产出取不回来：HTTP ${upstream.status}`)
  return {
    bytes: new Uint8Array(await upstream.arrayBuffer()),
    mime: upstream.headers.get('content-type') ?? ref.mime,
  }
}

async function readTaskOutput(
  output: TaskOutput,
  userId: string | null,
): Promise<Omit<ResolvedAgentImage, 'imageId'> | null> {
  const ref = await resolveTaskOutputRef(output, userId)
  if (!ref) return null
  try {
    const read = await readOutputBytes(ref)
    return { dataUrl: dataUrl(read.bytes, read.mime) }
  } catch {
    return null
  }
}

/** 历史里的工具结果块记着每件产物的任务与下标，所以产物不必另立一张表。 */
function outputsFromHistory(history: readonly AgentMessageView[]): {
  images: Map<string, TaskOutput>
  videos: Map<string, VideoOutput>
} {
  const images = new Map<string, TaskOutput>()
  const videos = new Map<string, VideoOutput>()
  for (const message of history) {
    for (const block of message.content) {
      if (block.type !== 'toolResult') continue
      rememberImages(images, block.artifacts ?? [])
      rememberVideos(videos, block.artifacts ?? [])
    }
  }
  return { images, videos }
}

/** 视频取不出可编辑的位图，所以只有图片产物进得来。 */
function rememberImages(
  outputs: Map<string, TaskOutput>,
  artifacts: readonly AgentToolArtifact[],
): void {
  for (const artifact of artifacts) {
    if (artifact.media !== 'image') continue
    outputs.set(artifact.artifactId, {
      taskId: artifact.taskId,
      outputIndex: artifact.outputIndex,
    })
  }
}

/**
 * 视频产物走自己这张表：模型指得到它、工具取得到它的字节，但它永远不会被当成一张图
 * 送进模型的上下文，也不会被改图工具误取。
 */
function rememberVideos(
  outputs: Map<string, VideoOutput>,
  artifacts: readonly AgentToolArtifact[],
): void {
  for (const artifact of artifacts) {
    if (artifact.media !== 'video') continue
    outputs.set(artifact.artifactId, {
      taskId: artifact.taskId,
      outputIndex: artifact.outputIndex,
      mime: artifact.mime,
    })
  }
}

/** 用户在这张图上画没画遮罩。新旧两种引用形态各把它存在不同字段里，问法只此一处。 */
export function referenceHasMask(reference: AgentImageReference): boolean {
  return Boolean('dataUrl' in reference ? reference.maskDataUrl : reference.mask)
}

/** 附在用户消息后面送给模型；没有引用时是空串。 */
export function referenceManifest(references: readonly AgentImageReference[]): string {
  if (references.length === 0) return ''
  const lines = references.map((one, at) => {
    const name = one.name ? `${one.name}，` : ''
    const mask = referenceHasMask(one)
      ? '，蓝色半透明覆盖处是用户圈选区（仅供定位，不是图中原有颜色；编辑时用原图）。作为编辑目标时只改圈选内，作为参考时只参考圈选内容'
      : ''
    return `[image ${at + 1}] ${name}图片 id ${one.imageId}${mask}`
  })
  return `\n\n可用参考图（工具参数使用图片 id，不要把编号当 id）：\n${lines.join('\n')}`
}

/** 保留最近一批引用的编号；更早的图仍可凭原 id 取回。 */
export function activeAgentReferences(
  current: readonly AgentTurnReference[],
  history: readonly AgentMessageView[],
): readonly AgentImageReference[] {
  if (current.length) return current
  for (let at = history.length - 1; at >= 0; at--) {
    const message = history[at]!
    if (message.role !== 'user') continue
    for (let index = message.content.length - 1; index >= 0; index--) {
      const block = message.content[index]!
      if (block.type === 'text' && block.references?.length) return block.references
    }
  }
  return []
}

export async function removeAgentTurnReferences(
  conversationId: string,
  turnId: string,
): Promise<void> {
  try {
    await objectStore().deletePrefix(`agent/${conversationId}/${turnId}/`)
  } catch (err) {
    log.warn(
      { event: 'agent.reference_cleanup_failed', conversationId, turnId, err },
      'reference cleanup failed',
    )
  }
}

export async function archiveAgentReferences(
  conversationId: string,
  turnId: string,
  references: readonly AgentTurnReference[],
): Promise<AgentStoredReference[]> {
  const stored: AgentStoredReference[] = []
  try {
    for (const [index, reference] of references.entries()) {
      const archived = await archiveInputImages(`agent/${conversationId}/${turnId}/${index}`, {
        prompt: '',
        input_images: [reference.dataUrl],
        ...(reference.maskDataUrl ? { mask: reference.maskDataUrl } : {}),
      })
      stored.push({
        imageId: reference.imageId,
        ...(reference.name ? { name: reference.name } : {}),
        image: archived.input_images![0] as StoredImageRef,
        ...(archived.mask ? { mask: archived.mask as StoredImageRef } : {}),
      })
    }
    return stored
  } catch (error) {
    await removeAgentTurnReferences(conversationId, turnId)
    throw error
  }
}

export function createAgentImageSource(input: {
  readonly references: readonly AgentTurnReference[]
  readonly history: readonly AgentMessageView[]
  readonly userId: string | null
}): AgentImageSource {
  const { userId } = input
  let active = activeAgentReferences(input.references, input.history)
  const references = new Map<string, AgentImageReference>()
  for (const message of input.history) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const reference of block.references ?? []) references.set(reference.imageId, reference)
    }
  }
  for (const reference of input.references) references.set(reference.imageId, reference)
  const { images: outputs, videos } = outputsFromHistory(input.history)
  // 缓存 promise 而不是值：模型连着改同一张图时，重复的那几次连 I/O 都不发。
  const resolving = new Map<string, Promise<ResolvedAgentImage | null>>()

  const read = async (imageId: string): Promise<ResolvedAgentImage | null> => {
    const reference = references.get(imageId)
    if (reference) {
      const hydrated =
        'dataUrl' in reference
          ? { input_images: [reference.dataUrl], mask: reference.maskDataUrl }
          : await hydrateInputImages({
              prompt: '',
              input_images: [reference.image],
              mask: reference.mask,
            })
      return {
        imageId,
        dataUrl: hydrated.input_images![0]!,
        ...(hydrated.mask ? { maskDataUrl: hydrated.mask } : {}),
      }
    }
    const output = outputs.get(imageId)
    if (output) {
      const image = await readTaskOutput(output, userId)
      return image ? { imageId, ...image } : null
    }
    if (!userId) return null
    const asset = await readAssetImage(userId, imageId)
    return asset ? { imageId, dataUrl: dataUrl(asset.bytes, asset.contentType) } : null
  }

  const identify = (imageId: string): string => {
    if (references.has(imageId) || outputs.has(imageId)) return imageId
    const ordinal = /^(?:image\s+([1-9]\d*)|\[image\s+([1-9]\d*)\])$/i.exec(imageId.trim())
    if (!ordinal) return imageId
    return active[Number(ordinal[1] ?? ordinal[2]) - 1]?.imageId ?? imageId
  }

  return {
    get references() {
      return active
    },
    get masked() {
      return active.some(referenceHasMask)
    },
    attach(added) {
      if (!added.length) return
      active = added
      for (const reference of added) {
        references.set(reference.imageId, reference)
        resolving.delete(reference.imageId)
      }
    },
    note(artifacts) {
      rememberImages(outputs, artifacts)
      rememberVideos(videos, artifacts)
    },

    get videoIds() {
      return [...videos.keys()]
    },

    async resolveVideo(videoId) {
      const output = videos.get(videoId.trim())
      if (!output) return { kind: 'unknown' }
      const ref = await resolveTaskOutputRef(output, userId)
      if (!ref) return { kind: 'unavailable' }
      return {
        kind: 'ready',
        video: {
          videoId,
          taskId: output.taskId,
          outputIndex: output.outputIndex,
          mime: output.mime,
          read: async () => (await readOutputBytes(ref)).bytes,
        },
      }
    },

    identify,

    resolve(imageId) {
      const id = identify(imageId)
      const running = resolving.get(id)
      if (running) return running
      const started = read(id).then(modelImage)
      resolving.set(id, started)
      return started
    },
  }
}
