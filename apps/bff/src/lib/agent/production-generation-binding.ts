import type {
  ProductionContent,
  ProductionGenerationBinding,
  ProductionGenerationDraftInput,
  ProductionGenerationReference,
  ProductionMediaReference,
} from '@image-playground/shared'
import { parseProjectArtifactId, productionClipVideo } from '@image-playground/shared'
import { decodeDataUrl } from '../imageArchive'
import { readAssetImage } from '../sync-assets'
import { createAgentImageSource, readConversationMedia } from './images'
import { ProductionError, readProduction } from './production'

import { productionClipDependencies } from './production-dependencies'
import { validateProductionMediaReferences } from './production-references'
import { AgentToolError } from './tools/errors'

export function targetSnapshot(
  content: ProductionContent,
  input: Pick<ProductionGenerationDraftInput, 'target' | 'targetId'>,
  requireComplete = true,
): ProductionGenerationBinding['snapshot'] {
  if (input.target === 'clip') {
    const clip = content.clips?.find((one) => one.id === input.targetId)
    if (!clip) throw new ProductionError('production_not_found')
    if (
      requireComplete &&
      clip.shotIds.some((id) => !content.shots?.some((shot) => shot.id === id))
    )
      throw new ProductionError('production_invalid')
    return {
      name: clip.name,
      description: clip.prompt,
      references: clip.references.map((one) => one.reference),
      shotIds: [...clip.shotIds],
      dependencies: productionClipDependencies(content, clip.shotIds),
      model: clip.model,
      video: productionClipVideo(clip),
    }
  }
  const target =
    input.target === 'look'
      ? content.characters
          ?.flatMap((character) => character.looks)
          .find((look) => look.id === input.targetId)
      : input.target === 'location'
        ? content.locations?.find((location) => location.id === input.targetId)
        : undefined
  if (!target) throw new ProductionError('production_not_found')
  return {
    ...(input.target === 'look'
      ? {
          character: content.characters
            ?.filter((character) => character.looks.some((look) => look.id === input.targetId))
            .map(({ id, name, description }) => ({ id, name, description }))[0],
        }
      : {}),
    name: target.name,
    description: target.description,
    references: target.reference ? [target.reference] : [],
  }
}
export async function referenceDataUrl(
  conversationId: string,
  userId: string,
  reference: ProductionMediaReference,
): Promise<string> {
  if (reference.kind === 'artifact') {
    const image = await createAgentImageSource({
      conversationId,
      userId,
      references: [],
      history: [],
    }).resolve(reference.artifactId, 'original')
    if (!image) throw new ProductionError('production_invalid')
    decodeDataUrl(image.dataUrl)
    return image.dataUrl
  }
  const image =
    reference.kind === 'asset'
      ? await readAssetImage(userId, reference.imageId)
      : await readConversationMedia(reference.mediaId, conversationId, userId, 'original', true)
  if (!image || !image.contentType.startsWith('image/'))
    throw new ProductionError('production_invalid')
  return `data:${image.contentType};base64,${Buffer.from(image.bytes).toString('base64')}`
}

export async function bindProductionGeneration(
  context: import('./tools/types').AgentToolContext,
  input: {
    media: 'image' | 'video'
    referenceIds?: readonly string[]
    inputImages?: readonly string[]
    video?: import('@image-playground/shared').PersistedVideoRequest
  },
) {
  const selected = context.params?.production
  if (!selected || !['look', 'location', 'clip'].includes(selected.target)) return undefined
  if (!context.userId) throw new AgentToolError('authentication_required', '请先登录')
  const target = selected.target as ProductionGenerationBinding['target']
  if ((target === 'clip') !== (input.media === 'video'))
    throw new AgentToolError('invalid_params', '当前选中对象与生成类型不匹配')
  const targetId =
    target === 'look'
      ? selected.lookId
      : target === 'location'
        ? selected.locationId
        : selected.clipId
  if (!targetId) throw new AgentToolError('invalid_params', '请重新选择生成对象')
  const record = await readProduction(context.conversationId, context.userId)
  if (
    !record ||
    record.document.id !== selected.documentId ||
    record.document.revision !== selected.revision
  )
    throw new AgentToolError('invalid_params', '制作文档已更新，请重新选择对象后生成')
  if (input.video?.mode && input.video.mode !== 'generate')
    throw new AgentToolError('invalid_params', '制作片段暂不支持续写或改视频模式')
  let snapshot: ProductionGenerationBinding['snapshot']
  try {
    snapshot = targetSnapshot(record.document.content, { target, targetId })
  } catch {
    throw new AgentToolError('invalid_params', '生成对象或其分镜已失效，请先更新制作文档')
  }
  let references: ProductionGenerationReference[] = []
  if (input.inputImages?.length) {
    const referenceIds = input.referenceIds
    if (!referenceIds || referenceIds.length !== input.inputImages.length)
      throw new AgentToolError('invalid_params', '请从制作面板重新选择参考图')
    for (const [index, id] of referenceIds.entries()) {
      const candidates: ProductionMediaReference[] = parseProjectArtifactId(id)
        ? [{ kind: 'artifact', artifactId: id }]
        : [
            { kind: 'media', mediaId: id },
            { kind: 'asset', imageId: id },
          ]
      let found: ProductionMediaReference | undefined
      for (const candidate of candidates)
        if (
          await validateProductionMediaReferences(context.conversationId, context.userId, [
            candidate,
          ])
        ) {
          found = candidate
          break
        }
      if (!found) throw new AgentToolError('invalid_params', '参考图不可用，请从制作面板重新选择')
      references.push({
        reference: found,
        ...(input.media === 'video'
          ? {
              usage:
                input.video?.first_frame_index === index
                  ? ('first-frame' as const)
                  : input.video?.last_frame_index === index
                    ? ('last-frame' as const)
                    : ('reference' as const),
            }
          : {}),
      })
    }
  } else {
    references =
      target === 'clip'
        ? [...record.document.content.clips!.find((clip) => clip.id === targetId)!.references]
        : snapshot.references.map((reference) => ({ reference }))
  }
  if (
    !(await validateProductionMediaReferences(
      context.conversationId,
      context.userId,
      references.map((one) => one.reference),
    ))
  )
    throw new AgentToolError('invalid_params', '参考图已失效')
  const inputImages = input.inputImages?.length
    ? [...input.inputImages]
    : await Promise.all(
        references.map((one) =>
          referenceDataUrl(context.conversationId, context.userId!, one.reference),
        ),
      )
  const production: ProductionGenerationBinding = {
    documentId: selected.documentId,
    revision: selected.revision,
    target,
    targetId,
    snapshot,
  }
  return { production, references, inputImages }
}
