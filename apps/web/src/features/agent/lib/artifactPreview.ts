import type { AgentToolArtifact } from '@image-playground/shared'
import { fetchToolImage, toolArtifactUrl } from './agentClient'
import { agentCanvasSink } from './canvasSink'
import { videoPosterDataUrl } from './videoPoster'

/** 结果卡上一张产出此刻的样子。 */
export interface AgentArtifactPreview {
  readonly artifact: AgentToolArtifact
  /** 看得见的位图；服务端也取不到才是 null。 */
  readonly source: string | null
  /** 这张产出在不在画布上。「放入画布」入口与点击定位都从它反查，不看交付标记。 */
  readonly onCanvas: boolean
}

/** 回退取回来的是原图，按产物 id 存着但不无限存：面板折叠、切页签都会重新问一遍。 */
const REMOTE_CACHE_LIMIT = 12

const remote = new Map<string, Promise<string | null>>()

function remotePreview(artifact: AgentToolArtifact): Promise<string | null> {
  const cached = remote.get(artifact.artifactId)
  if (cached) return cached
  const pending = (
    artifact.media === 'video'
      ? videoPosterDataUrl(toolArtifactUrl(artifact), artifact)
      : fetchToolImage(artifact)
  ).catch((error) => {
    console.warn('[agent] artifact preview fetch failed', error)
    // 失败的不留在缓存里，下次渲染还能再试。
    remote.delete(artifact.artifactId)
    return null
  })
  remote.set(artifact.artifactId, pending)
  for (const oldest of remote.keys()) {
    if (remote.size <= REMOTE_CACHE_LIMIT) break
    remote.delete(oldest)
  }
  return pending
}

/**
 * 画布仍是落在画布上那些产出的位图单源；不在画布上的产出回退到服务端取图，
 * 所以刷新之后、或者对象被删之后，结果卡仍看得见产出并能把它放回画布。
 */
export async function artifactPreview(artifact: AgentToolArtifact): Promise<AgentArtifactPreview> {
  const canvas = agentCanvasSink()
  if (canvas?.has(artifact.artifactId)) {
    const thumbnail = await canvas.thumbnail(artifact.artifactId)
    // 等缩略图期间画布可能已经换掉或对象已被删，那就当它不在画布上。
    if (thumbnail && agentCanvasSink() === canvas && canvas.has(artifact.artifactId))
      return { artifact, source: thumbnail, onCanvas: true }
  }
  return { artifact, source: await remotePreview(artifact), onCanvas: false }
}
