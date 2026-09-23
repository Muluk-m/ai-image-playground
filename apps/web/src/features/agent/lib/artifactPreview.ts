import type { AgentFetchedImage, AgentToolArtifact } from '@image-playground/shared'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { previewArtifactBitmap } from './artifactSource'
import { agentCanvasSink } from './canvasSink'

/** 结果卡上一张产出此刻的样子。 */
export interface AgentArtifactPreview {
  readonly artifact: AgentToolArtifact
  /** 看得见的位图；服务端也取不到才是 null。 */
  readonly source: string | null
  /** 这张产出在不在画布上。「放入画布」入口与点击定位都从它反查，不看交付标记。 */
  readonly onCanvas: boolean
}

/**
 * 画布仍是落在画布上那些产出的位图单源；不在画布上的产出回退到 `artifactSource` 取图，
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
  return { artifact, source: await previewArtifactBitmap(artifact), onCanvas: false }
}

/** 结果卡上一张取回来的网图此刻的样子。 */
export interface AgentFetchedPreview {
  readonly image: AgentFetchedImage
  /** 它在画布上的对象 id；点缩略图定位到它。 */
  readonly objectId: string
  readonly source: string | null
  readonly onCanvas: boolean
}

/**
 * 与产出同一条规矩：画布上有就以画布为单源，没有就回媒体库取一张预览——所以画布上被删掉
 * 之后，卡上仍看得见这张图，也还能把它放回画布。
 */
export async function fetchedImagePreview(
  image: AgentFetchedImage,
  objectId: string,
): Promise<AgentFetchedPreview> {
  const canvas = agentCanvasSink()
  if (canvas?.has(objectId)) {
    const thumbnail = await canvas.thumbnail(objectId)
    if (thumbnail && agentCanvasSink() === canvas && canvas.has(objectId))
      return { image, objectId, source: thumbnail, onCanvas: true }
  }
  const source = await resolveMediaSource(`aip-media:${image.imageId}`, 'preview').catch(() => null)
  return { image, objectId, source, onCanvas: false }
}
