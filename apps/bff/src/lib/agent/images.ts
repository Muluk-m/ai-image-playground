import type {
  AgentMessageView,
  AgentStoredReference,
  AgentToolArtifact,
  AgentTurnReference,
  StoredImageRef,
} from '@image-playground/shared'
import { AGENT_TURN_ATTACHED_MEDIA_MAX, parseProjectArtifactId } from '@image-playground/shared'
import { and, eq, exists, inArray, isNull, or, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { durableMediaStore } from '../durableMediaStore'
import { resolveImageBytesRef } from '../extractImages'
import { archiveInputImages, hydrateInputImages } from '../imageArchive'
import { log } from '../logger'
import { objectStore } from '../objectStore'
import { asQueueProvider } from '../queueProvider'
import { readAssetImage } from '../sync-assets'
import { taskAccessWhere } from '../task-access'
import { toModelImageDataUrl, toPreviewDataUrl } from './modelImage'
import { AgentToolError } from './tools/errors'

export type AgentImageReference = AgentTurnReference | AgentStoredReference

export interface ResolvedAgentImage {
  readonly imageId: string
  readonly dataUrl: string
  /** 本轮附图或系统续作计划中的遮罩；普通历史引用只有原图。 */
  readonly maskDataUrl?: string
}

/**
 * 要原件还是要预览。画布媒体两份都存着（`object_key` / `preview_key`），看一眼判断「这是不是
 * 那张图」用预览就够，而原件一次就是几 MB 的 data URL——全都按原件发，长会话必然先撞出站硬闸。
 * 其余来源（本轮附图、工具产物、素材）只有一份字节，`preview` 对它们无意义，照常给原件。
 */
export type AgentImageVariant = 'original' | 'preview'

/** 模型只会说图片 id，字节从哪来由这里决定。 */
export interface AgentImageSource {
  readonly references: readonly AgentImageReference[]
  /**
   * 当前请求作用域中是否有选区：本轮附图、未完成澄清链或已授权续作。
   * 普通历史图片的选区不在作用域内，不能把之后的新请求锁在局部改图里。
   */
  readonly masked: boolean
  /**
   * 模型说的那个 id 对应的真 id（把 `image 2` 这类编号翻回去），不读字节。
   * 工具起跑时要立刻把锚点告诉画布，那一刻等不起一次对象存储往返。
   */
  attach(references: readonly AgentTurnReference[]): void
  identify(imageId: string): string
  resolve(imageId: string, variant?: AgentImageVariant): Promise<ResolvedAgentImage | null>
  /** 记下工具刚产出的图，同一轮里下一个工具才能接着改它。视频不进这里：它取不出可编辑的位图。 */
  note(artifacts: readonly AgentToolArtifact[]): void
}

/**
 * 按 id 取图时要哪一份字节。只给 id 即原件：工具拿到的图要送进上游改，缩过的那一份不行。
 * 只有「给模型看一眼」的场合才写成带 `variant` 的形状。
 */
export type AgentImageRequest =
  | string
  | { readonly imageId: string; readonly variant: AgentImageVariant }

/** 按 id 取图，取不到就抛。工具共用这一句：模型换个 id 重试是它唯一的出路。 */
export async function requireAgentImages(
  source: AgentImageSource,
  requested: readonly AgentImageRequest[],
): Promise<ResolvedAgentImage[]> {
  const resolved = await Promise.all(
    requested.map((one) =>
      typeof one === 'string' ? source.resolve(one) : source.resolve(one.imageId, one.variant),
    ),
  )
  return resolved.map((image, at) => {
    if (!image) {
      const request = requested[at]!
      const available = source.references.map((reference) => reference.imageId).join('、')
      throw new AgentToolError(
        'invalid_params',
        `图片 ${typeof request === 'string' ? request : request.imageId} 不可用。${available ? `可用参考图 id：${available}；请核对后重试。` : '当前会话没有可用参考图。'}`,
      )
    }
    return image
  })
}

/**
 * 这一轮的引用里，哪几张的**内容**真的进这一份输入。规则只写在这里：实发首轮、插话、
 * 预扣估算与清单措辞四处共用它，不会各数各的。
 *
 * 内联那一路一定进：字节已经在请求体里了，不给模型看等于白传一遍，何况画了遮罩的图
 * 只能内联。按 id 附的那一路整批同进退——画布上一次圈几十张是常事，全塞进去既撑爆上下文
 * 也把出站带宽烧光；超过 {@link AGENT_TURN_ATTACHED_MEDIA_MAX} 张就只上清单，
 * 模型要看内容自己调 `viewImage`。
 */
export function shownTurnReferences<T extends AgentImageReference>(
  references: readonly T[],
): readonly T[] {
  let media = 0
  for (const one of references) if ('mediaId' in one) media += 1
  if (media <= AGENT_TURN_ATTACHED_MEDIA_MAX) return references
  return references.filter((one) => !('mediaId' in one))
}

/**
 * 这一轮要给模型看的那几张，连同各自该取哪一份字节。按 id 附的取预览：判断「是不是那张图」
 * 预览就够，原件一次就是几 MB。内联的本来只有一份，照常给原件——遮罩也只对得上原件的尺寸。
 */
export function shownImageRequests(
  references: readonly AgentImageReference[],
): AgentImageRequest[] {
  return shownTurnReferences(references).map((one) =>
    'mediaId' in one ? { imageId: one.imageId, variant: 'preview' as const } : one.imageId,
  )
}

/**
 * 把这一批刚到的引用里**要给模型看的那几张**解成字节。按 id 附来的从云媒体读回来，
 * 内联的原样用；张数多到只上清单的那些根本不解（见 `shownTurnReferences`）。
 *
 * 它不经 `AgentImageSource`：插话在被收下之前就要做视觉证据，这时把它们登记进图源
 * 会让一条可能被拒收的插话提前改掉本轮的活动引用。
 */
export async function resolveTurnReferences(
  references: readonly AgentTurnReference[],
  conversationId: string,
  userId: string | null,
): Promise<ResolvedAgentImage[]> {
  const resolved: ResolvedAgentImage[] = []
  for (const reference of shownTurnReferences(references)) {
    if (!('mediaId' in reference)) {
      resolved.push({
        imageId: reference.imageId,
        dataUrl: reference.dataUrl,
        ...(reference.maskDataUrl ? { maskDataUrl: reference.maskDataUrl } : {}),
      })
      continue
    }
    const media = await readConversationMedia(reference.mediaId, conversationId, userId, 'preview')
    // 认领是起轮前落下的，读不到只能是这中间媒体被删了；那张图这一轮就当没附。
    if (media)
      resolved.push({
        imageId: reference.imageId,
        dataUrl: dataUrl(media.bytes, media.contentType),
      })
  }
  return resolved
}

interface TaskOutput {
  readonly taskId: string
  readonly outputIndex: number
}

/**
 * 解析链内部的一份字节。`reduced` 表示它已经是预览规格——只有画布媒体有预留的预览，
 * 其余来源只存一份原件，要预览得读时现缩。
 */
type ReadImage = Omit<ResolvedAgentImage, 'imageId'> & { readonly reduced?: boolean }

function dataUrl(bytes: Uint8Array, mime: string): string {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return `data:${mime};base64,${view.toString('base64')}`
}

/**
 * 出解析链前的最后一道：格式归一（画布可存 SVG、用户能拖进 AVIF，上游只认几种位图），
 * 外加按需降采样。
 *
 * 降采样放在这里而不是各个来源里，是因为只有画布媒体有预留的预览；工具产物、素材、本轮
 * 附图都只存一份原件，而画布上被反复查看的恰恰是产物。放在各来源里就会漏掉它们。
 */
async function modelImage(
  image: (ReadImage & { readonly imageId: string }) | null,
  variant: AgentImageVariant,
): Promise<ResolvedAgentImage | null> {
  if (!image) return image
  const { reduced, ...rest } = image
  const normalized = await toModelImageDataUrl(rest.dataUrl)
  const dataUrl =
    variant === 'preview' && !reduced ? await toPreviewDataUrl(normalized) : normalized
  return dataUrl === rest.dataUrl ? rest : { ...rest, dataUrl }
}

async function readTaskOutput(
  output: TaskOutput,
  userId: string | null,
): Promise<Omit<ResolvedAgentImage, 'imageId'> | null> {
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
    return {
      dataUrl: dataUrl(
        await (ref.store === 'durable' ? durableMediaStore() : objectStore()).read(ref.data),
        ref.mime,
      ),
    }
  const upstream = await fetch(ref.data)
  if (!upstream.ok) return null
  const mime = upstream.headers.get('content-type') ?? ref.mime
  return { dataUrl: dataUrl(new Uint8Array(await upstream.arrayBuffer()), mime) }
}

/**
 * 窗口之外的产物。
 *
 * 折进摘要的那段历史不再读回来（#708），可摘要的「产物」一节仍然点着它们的 id，模型照样
 * 会去 `viewImage` / `editImage`。好在产物 id 本身就是 `agent_<任务 id>_<下标>`，解开它
 * 直接回表，比为这一张图把整段历史读回来便宜得多。
 *
 * 多一条会话限定：这个 id 来自模型输出，而模型输出受用户文本影响。「历史里出现过的才准
 * 解析」原先是隐含边界，回表时得由 SQL 把它写明。
 */
async function readFoldedOutput(
  imageId: string,
  conversationId: string,
  userId: string | null,
): Promise<Omit<ResolvedAgentImage, 'imageId'> | null> {
  const parsed = parseProjectArtifactId(imageId)
  if (!parsed) return null
  const [owned] = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, parsed.generationId),
        eq(schema.tasks.agent_conversation_id, conversationId),
      ),
    )
    .limit(1)
  if (!owned) return null
  return readTaskOutput({ taskId: parsed.generationId, outputIndex: parsed.position }, userId)
}

/** `aip-media:<uuid>` 是画布里存图片来源的写法，模型多半照抄过来，这里一并认。 */
const CANVAS_MEDIA_ID = /^(?:aip-media:)?([0-9a-f-]{36})$/i

/**
 * 这个会话读得到的那张云媒体的字节。
 *
 * 越权边界由 SQL 写明，比「归本人所有」更紧一格：只按 user_id 放行的话，模型报一串 uuid
 * 就能把这人别的项目里的图读出来。放行的只有两种认领关系：
 *
 * - **这一轮会话绑着的那个项目**认领着它：模型读画布报出来的 id 走这条。
 * - **这个会话自己**认领着它：用户按 id 附过来的参考图走这条（见 `claimConversationMedia`）。
 *   会话自己那一份是历史的锚：用户后来把这张图从画布上删了，项目那条认领会随下一次项目
 *   写入消失，历史里的引用不该跟着变成一张读不出来的图。
 */
export async function readConversationMedia(
  mediaId: string,
  conversationId: string,
  userId: string | null,
  variant: AgentImageVariant,
): Promise<{
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly reduced: boolean
} | null> {
  if (!userId) return null
  const [row] = await db
    .select({
      objectKey: schema.media_objects.object_key,
      previewKey: schema.media_objects.preview_key,
      contentType: schema.media_objects.content_type,
    })
    .from(schema.media_objects)
    .innerJoin(
      schema.media_references,
      and(
        eq(schema.media_references.media_id, schema.media_objects.id),
        eq(schema.media_references.user_id, userId),
        or(
          and(
            eq(schema.media_references.owner_kind, 'conversation'),
            eq(schema.media_references.owner_id, conversationId),
          ),
          and(
            eq(schema.media_references.owner_kind, 'project'),
            exists(
              db
                .select({ one: sql`1` })
                .from(schema.canvas_projects)
                .where(
                  and(
                    eq(schema.canvas_projects.id, schema.media_references.owner_id),
                    eq(schema.canvas_projects.conversation_id, conversationId),
                    isNull(schema.canvas_projects.deleted_at),
                  ),
                ),
            ),
          ),
        ),
      ),
    )
    .where(
      and(
        eq(schema.media_objects.id, mediaId),
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.status, 'ready'),
      ),
    )
    .limit(1)
  // 预览是上传时一并生成的，理论上 ready 的行两份都在；缺了就退回原件，宁可贵一次也别取不到图。
  const previewKey = variant === 'preview' ? row?.previewKey : null
  const key = previewKey ?? row?.objectKey
  if (!key) return null
  return {
    bytes: await durableMediaStore().read(key),
    // 预留的预览是 webp，原件那一行的 content type 对不上它，按字节认。
    contentType: previewKey ? 'image/webp' : row.contentType,
    reduced: previewKey !== null,
  }
}

/**
 * 画布上用户自己放的图。
 *
 * 它们的 id 是 `media_objects.id`，与产物 id（`agent_<任务>_<下标>`）、素材 id 都不是一个
 * 空间——不接这一路，`readCanvas` 报出来的图片 id 就交不给 `editImage`，读画布这件事等于白做。
 */
async function readCanvasMedia(
  imageId: string,
  conversationId: string,
  userId: string | null,
  variant: AgentImageVariant,
): Promise<ReadImage | null> {
  const mediaId = imageId.match(CANVAS_MEDIA_ID)?.[1]
  if (!mediaId) return null
  const media = await readConversationMedia(mediaId, conversationId, userId, variant)
  if (!media) return null
  // 预留的预览已经是这条规格缩过的，别再缩第二次。
  return {
    reduced: media.reduced,
    dataUrl: await toModelImageDataUrl(dataUrl(media.bytes, media.contentType)),
  }
}

/** 历史里的工具结果块记着每张产出图的任务与下标，所以产物不必另立一张表。 */
function outputsFromHistory(history: readonly AgentMessageView[]): Map<string, TaskOutput> {
  const outputs = new Map<string, TaskOutput>()
  for (const message of history) {
    for (const block of message.content) {
      if (block.type !== 'toolResult') continue
      rememberImages(outputs, block.artifacts ?? [])
    }
  }
  return outputs
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
 * 用户在这张图上画没画遮罩。三种引用形态各把它存在不同字段里，问法只此一处。
 * 云媒体那一路永远没有遮罩：画过遮罩的图是新像素，只能内联。
 */
export function referenceHasMask(reference: AgentImageReference): boolean {
  if ('maskDataUrl' in reference) return Boolean(reference.maskDataUrl)
  return 'mask' in reference && Boolean(reference.mask)
}

/**
 * 附在用户消息后面送给模型；没有引用时是空串。
 *
 * `selected` 说的是这批图**是不是用户为这一轮挑的**，与内容在不在这份输入里是两件事：
 *
 * - 上下文里沿用下来的（`false`）：它们不代表本轮意图，模型要看内容得自己调 `viewImage`。
 * - 本轮选中、内容也附上了的：连字节一起发，措辞照旧。
 * - 本轮选中、只给了 id 的（张数超过 {@link AGENT_TURN_ATTACHED_MEDIA_MAX}）：它们**是**
 *   本轮意图，只是内容没随这一轮发——把它说成「之前对话用到的图」会让模型当历史图忽略掉。
 *
 * 三种措辞共用同一份编号，`[image N]` 的可寻址性不因为字节没发而丢；编号一律按请求顺序数，
 * 用户那句话里写的 `[image N]` 指的就是这一个。
 */
export function referenceManifest(
  references: readonly AgentImageReference[],
  selected: boolean,
  maskScope: 'historical' | 'retained' = 'retained',
): string {
  if (references.length === 0) return ''
  const shown = selected ? shownTurnReferences(references) : []
  const attached = new Set(shown)
  // 一半附一半不附时逐条标注；整批同进退的两种情形由开头那句话一次说清。
  // 张数按数组长度比，不按集合大小：同一张图重复附两次时，集合会少数一个。
  const mixed = shown.length > 0 && shown.length < references.length
  const lines = references.map((one, at) => {
    const name = one.name ? `${one.name}，` : ''
    const mask = referenceHasMask(one)
      ? attached.has(one)
        ? '，蓝色半透明覆盖处是用户圈选区（仅供定位，不是图中原有颜色；编辑时用原图）。作为编辑目标时只改圈选内，作为参考时只参考圈选内容'
        : maskScope === 'retained'
          ? '，这次续作仍沿用此前的选区；作为编辑目标时只改圈选内，作为参考时只参考圈选内容'
          : '，此前附过选区；历史选区不代表本轮修改范围，以本轮附图或系统续作计划为准'
      : ''
    const carried = mixed && attached.has(one) ? '（内容已附在本轮输入里）' : ''
    return `[image ${at + 1}] ${name}图片 id ${one.imageId}${mask}${carried}`
  })
  const head = !selected
    ? maskScope === 'historical'
      ? '上下文里可取的图（工具参数使用图片 id，不要把编号当 id）：这些是之前对话用到的图，内容没有附在本轮输入里，它们不代表本轮意图；真需要看它们的内容时调 viewImage，改图直接把 id 交给 editImage。'
      : '上下文里可取的图（工具参数使用图片 id，不要把编号当 id）：这些是之前对话用到的图，内容没有附在本轮输入里；真需要看它们的内容时调 viewImage，改图直接把 id 交给 editImage。'
    : shown.length === references.length
      ? '可用参考图（工具参数使用图片 id，不要把编号当 id）；以下图的内容已附在本轮输入里：'
      : mixed
        ? '本轮用户选中的图（工具参数使用图片 id，不要把编号当 id）：它们都是用户为这次请求挑的图，标注「内容已附在本轮输入里」的那几张随这一轮发出，其余只给了 id；只有任务确实要看清某张的样子时才调 viewImage，改图或以图生图直接把 id 交给 editImage / generateImage，不必先看。'
        : '本轮用户选中的图（工具参数使用图片 id，不要把编号当 id）：它们都是用户为这次请求挑的图，张数较多，内容没有附在本轮输入里；只有任务确实要看清某张的样子时才调 viewImage，改图或以图生图直接把 id 交给 editImage / generateImage，不必先看。'
  return `\n\n${head}\n${lines.join('\n')}`
}

/**
 * 保留最近一批引用的编号；更早的图仍可凭原 id 取回。
 *
 * 沿用下来的这一批**只进清单文字**：它让 `[image N]` 仍然指得回真 id，不再让本轮重发字节。
 */
export function activeAgentReferences(
  current: readonly AgentTurnReference[],
  history: readonly AgentMessageView[],
  selectionHistoryStart = history.length,
): readonly AgentImageReference[] {
  if (current.length) return current
  for (let at = history.length - 1; at >= 0; at--) {
    const message = history[at]!
    if (message.role !== 'user') continue
    for (let index = message.content.length - 1; index >= 0; index--) {
      const block = message.content[index]!
      if (block.type === 'text' && block.references?.length) {
        return block.references.map((reference) => {
          if (!('mask' in reference) || !reference.mask || at >= selectionHistoryStart)
            return reference
          const { mask: _mask, ...original } = reference
          return original
        })
      }
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

/**
 * 会话删掉之后，它历轮的参考图就没有任何读路径了。逐轮前缀在正常跑完的轮上不会被清
 * （`removeAgentTurnReferences` 只在起轮失败的回滚路径上调），所以删会话时按会话前缀一次清掉。
 * 云媒体那一路没有副本，清的是这个会话对那些媒体的认领——不清的话，那几张图会被
 * `media_references` 的 `restrict` 永远钉在用户的配额里。
 */
export async function removeAgentConversationReferences(conversationId: string): Promise<void> {
  try {
    await db
      .delete(schema.media_references)
      .where(
        and(
          eq(schema.media_references.owner_kind, 'conversation'),
          eq(schema.media_references.owner_id, conversationId),
        ),
      )
  } catch (err) {
    log.warn(
      { event: 'agent.reference_cleanup_failed', conversationId, err },
      'conversation media claim cleanup failed',
    )
  }
  try {
    await objectStore().deletePrefix(`agent/${conversationId}/`)
  } catch (err) {
    log.warn(
      { event: 'agent.reference_cleanup_failed', conversationId, err },
      'conversation reference cleanup failed',
    )
  }
}

/**
 * 把几张云媒体挂到这个会话名下。
 *
 * 会话自己那条认领是历史的锚：它在，`readConversationMedia` 就读得到这张图，与画布后来
 * 怎么改无关。重复认领是常事（同一张图附两轮、取图两次取到同一个地址），所以忽略主键冲突。
 */
export async function addConversationMediaClaims(
  conversationId: string,
  userId: string,
  mediaIds: readonly string[],
): Promise<void> {
  if (mediaIds.length === 0) return
  const now = Date.now()
  await db
    .insert(schema.media_references)
    .values(
      mediaIds.map((mediaId) => ({
        user_id: userId,
        media_id: mediaId,
        owner_kind: 'conversation' as const,
        owner_id: conversationId,
        created_at: now,
      })),
    )
    .onConflictDoNothing()
}

/**
 * 让这个会话认领用户按 id 附过来的那几张云媒体，并顺带把越权挡在起轮之前。
 *
 * 两件事一次做完是刻意的：能认领就说明这张图确实是这个人的、确实还在（`ready`），
 * 认领落下之后 `readCanvasMedia` 才读得到它，而且读得到与画布后来怎么改无关。
 * 认领不上就是越权或图已经不在，调用方按 422 打回——那一轮还没开始，用户的话还在输入框里。
 */
export async function claimConversationMedia(
  conversationId: string,
  userId: string | null,
  references: readonly AgentTurnReference[],
): Promise<boolean> {
  const mediaIds = [
    ...new Set(references.flatMap((one) => ('mediaId' in one ? [one.mediaId] : []))),
  ]
  if (mediaIds.length === 0) return true
  // 匿名设备没有云媒体，按 id 附图对它无从成立。
  if (!userId) return false
  const owned = await db
    .select({ id: schema.media_objects.id })
    .from(schema.media_objects)
    .where(
      and(
        inArray(schema.media_objects.id, mediaIds),
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.status, 'ready'),
      ),
    )
  if (owned.length !== mediaIds.length) return false
  await addConversationMediaClaims(conversationId, userId, mediaIds)
  return true
}

/**
 * 把这一轮的参考图存成跨轮可读的快照。内联那一路把字节复制进对象存储；云媒体那一路
 * 只记 id——字节已经在 R2 里，复制第二遍既费出站带宽又白占一份配额，认领由
 * `claimConversationMedia` 在起轮之前落好。
 */
export async function archiveAgentReferences(
  conversationId: string,
  turnId: string,
  references: readonly AgentTurnReference[],
): Promise<AgentStoredReference[]> {
  const stored: AgentStoredReference[] = []
  try {
    for (const [index, reference] of references.entries()) {
      if ('mediaId' in reference) {
        stored.push({
          imageId: reference.imageId,
          ...(reference.name ? { name: reference.name } : {}),
          mediaId: reference.mediaId,
        })
        continue
      }
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
  /** 锚点之后那一段历史。更早的产物不在这里，按 id 回表取（`readFoldedOutput`）。 */
  readonly history: readonly AgentMessageView[]
  readonly conversationId: string
  readonly userId: string | null
  /** 未完成澄清链从此处继承选区；系统续作传 0，新请求默认不继承。 */
  readonly selectionHistoryStart?: number
}): AgentImageSource {
  const { userId } = input
  // 原图可跨请求复用，选区只在当前请求、澄清链或已授权续作中有效。
  const selectionHistoryStart = input.selectionHistoryStart ?? input.history.length
  const references = new Map<string, AgentImageReference>()
  for (const [index, message] of input.history.entries()) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const reference of block.references ?? []) {
        if ('mask' in reference && reference.mask && index < selectionHistoryStart) {
          const { mask: _mask, ...original } = reference
          references.set(reference.imageId, original)
        } else {
          references.set(reference.imageId, reference)
        }
      }
    }
  }
  for (const reference of input.references) references.set(reference.imageId, reference)
  let active: readonly AgentImageReference[] = activeAgentReferences(
    input.references,
    input.history,
    selectionHistoryStart,
  ).map((reference) => references.get(reference.imageId)!)
  const outputs = outputsFromHistory(input.history)
  // 缓存 promise 而不是值：模型连着改同一张图时，重复的那几次连 I/O 都不发。
  const resolving = new Map<string, Promise<ResolvedAgentImage | null>>()

  const read = async (
    imageId: string,
    variant: AgentImageVariant,
  ): Promise<ResolvedAgentImage | null> => {
    const reference = references.get(imageId)
    if (reference) {
      // 云媒体那一路没有副本，字节仍在 R2 的原件里；认领是起轮时落下的，所以读得到。
      if ('mediaId' in reference) {
        const media = await readCanvasMedia(
          reference.mediaId,
          input.conversationId,
          userId,
          variant,
        )
        return media ? { imageId, ...media } : null
      }
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
    const folded = await readFoldedOutput(imageId, input.conversationId, userId)
    if (folded) return { imageId, ...folded }
    const canvas = await readCanvasMedia(imageId, input.conversationId, userId, variant)
    if (canvas) return { imageId, ...canvas }
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
      for (const reference of references.values()) {
        if (referenceHasMask(reference)) return true
      }
      return false
    },
    attach(added) {
      if (!added.length) return
      active = added
      for (const reference of added) {
        references.set(reference.imageId, reference)
        for (const variant of ['original', 'preview']) {
          resolving.delete(`${variant}\u0000${reference.imageId}`)
        }
      }
    },
    note(artifacts) {
      rememberImages(outputs, artifacts)
    },

    identify,

    resolve(imageId, variant = 'original') {
      const id = identify(imageId)
      // 同一张图两种变体是两份字节，缓存不能共用一个键。
      const key = `${variant}\u0000${id}`
      const running = resolving.get(key)
      if (running) return running
      const started = read(id, variant).then((image) => modelImage(image, variant))
      resolving.set(key, started)
      return started
    },
  }
}
