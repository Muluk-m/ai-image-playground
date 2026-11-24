import {
  type AgentToolArtifact,
  type ChannelMedia,
  projectArtifactId,
} from '@image-playground/shared'
import type { ExtractedResult } from '../extractImages'

export function queueArtifacts(
  taskId: string,
  media: ChannelMedia,
  result: ExtractedResult,
): AgentToolArtifact[] {
  return result.images.map((output) => ({
    // 画布对象与结果卡共用这个 id，点卡才能定位到同一个对象。
    artifactId: projectArtifactId(taskId, output.index),
    media,
    taskId,
    outputIndex: output.index,
    mime: output.mime,
    ...(output.width !== undefined ? { width: output.width } : {}),
    ...(output.height !== undefined ? { height: output.height } : {}),
  }))
}
