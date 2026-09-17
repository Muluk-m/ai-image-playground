import type { AgentToolArtifact } from '@image-playground/shared'
import { AGENT_CONVERSATION_KEY, scopedStorageName } from '../../../lib/authScope'
import { fetchImageDataUrl, queueOutputUrl } from '../../../lib/channels/queueClient'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { blankVideoPoster, captureVideoPoster } from './videoPoster'

/** 队列里的一份产出。视频的封面与播放都打这个地址，图片的原图在它隔壁的 `/image/`。 */
export interface QueueOutputRef {
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

function cached(key: string, load: () => Promise<string | null>): Promise<string | null> {
  const scoped = `${scopedStorageName(AGENT_CONVERSATION_KEY)}:${key}`
  const hit = bitmaps.get(scoped)
  if (hit) return hit
  const pending = load().then((bitmap) => {
    if (!bitmap) bitmaps.delete(scoped)
    return bitmap
  })
  bitmaps.set(scoped, pending)
  for (const oldest of bitmaps.keys()) {
    if (bitmaps.size <= CACHE_LIMIT) break
    bitmaps.delete(oldest)
  }
  return pending
}

/** 队列里那份视频的真首帧，抓不到就是 null——画布上的封面该不该动由调用方决定。 */
export function videoOutputFrame(output: QueueOutputRef): Promise<string | null> {
  return cached(`frame:${output.taskId}/${output.outputIndex}`, () =>
    captureVideoPoster(queueOutputUrl(output.taskId, output.outputIndex)),
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
