import type { AgentToolArtifact } from '@image-playground/shared'
import { AGENT_CONVERSATION_KEY, scopedStorageName } from '../../../lib/authScope'
import { fetchImageDataUrl, videoOutputUrl } from '../../../lib/channels/queueClient'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { blankVideoPoster, captureVideoPoster } from './videoPoster'

/** 队列里的一份产出。视频的封面与播放都打这个地址，图片的原图在它隔壁的 `/image/`。 */
export interface QueueOutputRef {
  readonly mediaId?: string
  readonly taskId: string
  readonly outputIndex: number
}

/** 位图不无限存：面板折叠、切页签都会重新问一遍，留最近这些够用。 */
const CACHE_LIMIT = 12
/**
 * 唯一那份缓存，按来源分槽（`frame:` 是真首帧，`artifact:` 是结果卡看到的那张）。
 * 一条失效规则：取到了才留，取不到（图片没下来、首帧抓不着）就不留，下次还能再试。
 */
const bitmaps = new Map<string, Promise<string | null>>()

function remember(key: string, bitmap: Promise<string | null>): void {
  bitmaps.set(key, bitmap)
  for (const oldest of bitmaps.keys()) {
    if (bitmaps.size <= CACHE_LIMIT) break
    bitmaps.delete(oldest)
  }
}

function cached(key: string, load: () => Promise<string | null>): Promise<string | null> {
  const scoped = `${scopedStorageName(AGENT_CONVERSATION_KEY)}:${key}`
  const hit = bitmaps.get(scoped)
  if (hit) return hit
  const pending = load().then((bitmap) => {
    if (!bitmap && bitmaps.get(scoped) === pending) bitmaps.delete(scoped)
    return bitmap
  })
  remember(scoped, pending)
  return pending
}

/** 只读已有封面或正在进行的抓取，结果卡不得为封面再开一条视频流。 */
export function cachedVideoOutputFrame(output: QueueOutputRef): Promise<string | null> | undefined {
  return bitmaps.get(
    `${scopedStorageName(AGENT_CONVERSATION_KEY)}:frame:${output.taskId}/${output.outputIndex}`,
  )
}

/** 播放器已解码的首帧供画布与预览复用。 */
export function rememberVideoOutputFrame(output: QueueOutputRef, frame: string): void {
  const key = `${scopedStorageName(AGENT_CONVERSATION_KEY)}:frame:${output.taskId}/${output.outputIndex}`
  remember(key, Promise.resolve(frame))
}

/** 队列里那份视频的真首帧，抓不到就是 null——画布上的封面该不该动由调用方决定。 */
export function videoOutputFrame(output: QueueOutputRef): Promise<string | null> {
  return cached(`frame:${output.taskId}/${output.outputIndex}`, () =>
    captureVideoPoster(videoOutputUrl(output)),
  )
}

/**
 * 一件产物的位图从哪来，只在这里回答一次：视频取封面（抓不到给深色底，仍然点得开），
 * 图片取原图（取不到就抛，交付据此记失败）。
 *
 * 这条路不留副本：字节要么进画布——画布随后就是这张位图的单源——要么由下面那个
 * 带缓存的入口替结果卡记着。
 */
export async function artifactBitmap(artifact: AgentToolArtifact): Promise<string> {
  if (artifact.media !== 'video' && artifact.mediaId)
    return resolveMediaSource(`aip-media:${artifact.mediaId}`, 'original', true)
  if (artifact.media !== 'video')
    return fetchImageDataUrl(bffBaseUrl(), artifact.taskId, artifact.outputIndex, artifact.mime)
  return (await videoOutputFrame(artifact)) ?? blankVideoPoster(artifact)
}

/** 结果卡上不在画布上的那些产出：回退到服务端取图并记着，服务端也取不到才是 null。 */
export function previewArtifactBitmap(artifact: AgentToolArtifact): Promise<string | null> {
  return cached(`artifact:${artifact.artifactId}`, () =>
    artifactBitmap(artifact).catch((error) => {
      console.warn('[agent] artifact bitmap fetch failed', error)
      return null
    }),
  )
}

/**
 * 只为看一眼：有媒体身份就取 1024px 的预览档（本机落盘、签名直链），没有才回退到原图。
 * 下载、改图、抠图这些要像素的地方用 {@link previewArtifactBitmap}，它给的是原图。
 */
export function displayArtifactBitmap(artifact: AgentToolArtifact): Promise<string | null> {
  if (artifact.media === 'video' || !artifact.mediaId) return previewArtifactBitmap(artifact)
  return resolveMediaSource(`aip-media:${artifact.mediaId}`, 'display').catch(() =>
    previewArtifactBitmap(artifact),
  )
}

/**
 * 产物当参考图时的来源。有媒体身份直接按 id 引用：不下载、不重新上传，模型拿到的是原图。
 * 没有时（实时流里刚出的结果）先用画布上那份原件，再退回原图字节——同一份字节服务端按哈希认出，
 * 不会存第二份。
 */
export async function artifactReferenceSource(
  artifact: AgentToolArtifact,
  canvasSource?: string,
): Promise<string | null> {
  return (
    knownArtifactReferenceSource(artifact, canvasSource) ?? (await previewArtifactBitmap(artifact))
  )
}

/** 不用取字节就知道的那份来源；调用方据此同步插入，免得等一拍时草稿已经变了。 */
export function knownArtifactReferenceSource(
  artifact: AgentToolArtifact,
  canvasSource?: string,
): string | undefined {
  if (artifact.media !== 'video' && artifact.mediaId) return `aip-media:${artifact.mediaId}`
  return canvasSource
}
