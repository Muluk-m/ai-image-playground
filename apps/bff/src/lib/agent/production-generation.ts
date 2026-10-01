import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  AgentToolResultBlock,
  ProductionContent,
  ProductionGenerationBinding,
  ProductionGenerationDraftInput,
  ProductionGenerationView,
  ProductionMediaReference,
} from '@image-playground/shared'
import {
  parseProjectArtifactId,
  productionClipVideo,
  videoPromptRejection,
  videoRequestRejection,
} from '@image-playground/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { resolveQueueModel } from '../channels'
import { extractMeta } from '../extractImages'
import { archiveInputImages, decodeDataUrl } from '../imageArchive'
import { objectStore } from '../objectStore'
import { asQueueProvider } from '../queueProvider'
import { readAssetImage } from '../sync-assets'
import { saveGenerationDraft } from './confirmations'
import { appendAgentMessage } from './conversations'
import { createAgentImageSource, readConversationMedia } from './images'
import {
  applyProductionMutation,
  ProductionError,
  readProduction,
  updateProductionRecord,
} from './production'
import { productionReferenceId } from './production-asset-validation'
import { validateImageParameters } from './production-generation-validation'
import { validateProductionMediaReferences } from './production-references'
import { queueParamsFor } from './tools/queueParams'
import { queueArtifacts } from './tools/queueTask'

const drafts = schema.agent_generation_drafts
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function targetSnapshot(
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
    name: target.name,
    description: target.description,
    references: target.reference ? [target.reference] : [],
  }
}
function validateVideoInput(
  input: Pick<ProductionGenerationDraftInput, 'model' | 'prompt' | 'video' | 'references'>,
) {
  if (
    !input.video ||
    (input.video.mode && input.video.mode !== 'generate') ||
    videoRequestRejection(input.model, input.video, input.references.length) ||
    videoPromptRejection(input.model, input.prompt)
  )
    throw new ProductionError('production_invalid')
  if (input.references.some((one) => !one.usage)) throw new ProductionError('production_invalid')
  const refs = input.references.map((one) => ({ reference: one.reference, usage: one.usage! }))
  if (
    refs.filter((one) => one.usage === 'first-frame').length > 1 ||
    refs.filter((one) => one.usage === 'last-frame').length > 1 ||
    !isDeepStrictEqual(productionClipVideo({ video: input.video, references: refs }), input.video)
  )
    throw new ProductionError('production_invalid')
}
async function referenceDataUrl(
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
export async function listProductionGenerations(
  conversationId: string,
  userId: string,
): Promise<ProductionGenerationView[]> {
  await readProduction(conversationId, userId)
  const rows = await db
    .select()
    .from(drafts)
    .where(
      and(
        eq(drafts.conversation_id, conversationId),
        sql`${drafts.submission} -> 'production' IS NOT NULL`,
      ),
    )
    .orderBy(desc(drafts.created_at))
    .limit(100)
  const result: ProductionGenerationView[] = []
  for (const draft of rows) {
    if (!draft.submission.production) continue
    const messages = await db
      .select()
      .from(schema.agent_messages)
      .where(
        and(
          eq(schema.agent_messages.conversation_id, conversationId),
          eq(schema.agent_messages.turn_id, draft.turn_id),
        ),
      )
      .limit(100)
    const message = messages.find((item) =>
      item.content.some(
        (block) => block.type === 'toolResult' && block.toolCallId === draft.tool_call_id,
      ),
    )
    const card = message?.content.find(
      (block): block is AgentToolResultBlock =>
        block.type === 'toolResult' && block.toolCallId === draft.tool_call_id,
    )
    let artifacts: ProductionGenerationView['artifacts'] = []
    let status = 'awaiting_confirmation'
    if (draft.task_id) {
      const [task] = await db
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.id, draft.task_id),
            eq(schema.tasks.user_id, userId),
            eq(schema.tasks.agent_conversation_id, conversationId),
          ),
        )
        .limit(1)
      status = task?.status ?? 'missing'
      const provider = task && asQueueProvider(task.provider)
      if (task?.status === 'completed' && provider)
        artifacts = queueArtifacts(task.id, draft.media, extractMeta(provider, task.result_payload))
    }
    result.push({
      draftId: draft.id,
      messageId: message?.id ?? '',
      draftRevision: draft.submission.productionDraftRevision ?? 1,
      production: draft.submission.production,
      model: draft.model,
      prompt: draft.prompt,
      params: draft.submission.productionParams,
      ...(draft.request.video ? { video: draft.request.video } : {}),
      references: draft.submission.productionReferences ?? [],
      status: card?.status === 'failed' && !draft.task_id ? 'failed' : status,
      ...(draft.task_id ? { taskId: draft.task_id } : {}),
      artifacts,
    })
  }
  return result
}
export async function createProductionGenerationDraft(
  conversationId: string,
  userId: string,
  input: ProductionGenerationDraftInput,
): Promise<ProductionGenerationView> {
  const record = await readProduction(conversationId, userId)
  if (!record) throw new ProductionError('production_not_found')
  if (
    !input.operationId ||
    input.operationId.length > 128 ||
    !input.prompt.trim() ||
    input.prompt.length > 8000 ||
    input.references.length > 16
  )
    throw new ProductionError('production_invalid')
  const requestFingerprint = fingerprint(input)
  const toolCallId = `production:${fingerprint([conversationId, input.operationId])}`
  const [replay] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.conversation_id, conversationId), eq(drafts.tool_call_id, toolCallId)))
    .limit(1)
  if (replay) {
    if (replay.submission.productionFingerprint !== requestFingerprint)
      throw new ProductionError('production_operation_reused')
    return (await listProductionGenerations(conversationId, userId)).find(
      (item) => item.draftId === replay.id,
    )!
  }
  if (record.document.revision !== input.baseRevision)
    throw new ProductionError('production_conflict', record.document)
  const snapshot = targetSnapshot(record.document.content, input)
  const media = input.target === 'clip' ? 'video' : 'image'
  const target = resolveQueueModel(media, input.model)
  if (!target) throw new ProductionError('production_invalid')
  if (media === 'video') {
    const clip = record.document.content.clips!.find((one) => one.id === input.targetId)!
    if (
      input.prompt !== clip.prompt ||
      input.model !== clip.model ||
      !isDeepStrictEqual(input.references, clip.references) ||
      !isDeepStrictEqual(input.video, productionClipVideo(clip))
    )
      throw new ProductionError('production_invalid')
    validateVideoInput(input)
  } else {
    if (input.video) throw new ProductionError('production_invalid')
    validateImageParameters(input.model, target.provider, input.params, input.references.length)
  }
  const toolName = media === 'video' ? 'generateVideo' : 'generateImage'
  if (
    !(await validateProductionMediaReferences(
      conversationId,
      userId,
      input.references.map((item) => item.reference),
    ))
  )
    throw new ProductionError('production_invalid')
  let inputImages: string[]
  try {
    inputImages = await Promise.all(
      input.references.map((item) => referenceDataUrl(conversationId, userId, item.reference)),
    )
  } catch {
    throw new ProductionError('production_invalid')
  }
  const production: ProductionGenerationBinding = {
    documentId: record.document.id,
    revision: input.baseRevision,
    target: input.target,
    targetId: input.targetId,
    snapshot,
  }
  const turnId = `production:${crypto.randomUUID()}`
  const draftId = await saveGenerationDraft(
    {
      conversationId,
      turnId,
      toolCallId,
      toolName,
      media,
      provider: target.provider,
      model: target.model,
      prompt: input.prompt,
      request: {
        prompt: input.prompt,
        ...(media === 'image' ? queueParamsFor(target.provider, input.params) : {}),
        n: 1,
        ...(inputImages.length ? { input_images: inputImages } : {}),
      },
      ...(input.video ? { video: input.video } : {}),
      submission: {
        review: false,
        production,
        productionDraftRevision: 1,
        ...(input.video
          ? {
              videoRecord: {
                model: input.model,
                duration: input.video.duration_seconds,
                aspectRatio: input.video.aspect_ratio,
                resolution: input.video.resolution,
              },
            }
          : {}),
        productionParams: input.params,
        productionReferences: input.references,
        productionOperationId: input.operationId,
        productionFingerprint: requestFingerprint,
      },
    },
    async (draft) => {
      let id = draft.id
      await updateProductionRecord(conversationId, userId, async (current, tx) => {
        const [existing] = await tx
          .select()
          .from(drafts)
          .where(
            and(eq(drafts.conversation_id, conversationId), eq(drafts.tool_call_id, toolCallId)),
          )
          .limit(1)
        if (existing) {
          if (existing.submission.productionFingerprint !== requestFingerprint)
            throw new ProductionError('production_operation_reused')
          id = existing.id
          return current
        }
        if (current.document.revision !== input.baseRevision)
          throw new ProductionError('production_conflict', current.document)
        targetSnapshot(current.document.content, input)
        if (
          !(await validateProductionMediaReferences(
            conversationId,
            userId,
            input.references.map((item) => item.reference),
            tx,
          ))
        )
          throw new ProductionError('production_invalid')
        await tx.insert(drafts).values(draft)
        await appendAgentMessage(tx, {
          conversationId,
          turnId,
          role: 'assistant',
          content: [
            {
              type: 'toolResult',
              toolCallId,
              toolName,
              status: 'awaiting_confirmation',
              productionDraftRevision: 1,
              title: `生成${snapshot.name}`,
              prompt: input.prompt,
              snapshot: {
                mode: media,
                args: {
                  prompt: input.prompt,
                  n: 1,
                  ...(input.video ? { video: input.video } : {}),
                },
                target,
                params: input.params,
                imageIds: input.references.map((item) => productionReferenceId(item.reference)),
              },
            },
          ],
        })
        return current
      })
      return id
    },
  )
  return (await listProductionGenerations(conversationId, userId)).find(
    (item) => item.draftId === draftId,
  )!
}

export async function editProductionGenerationDraft(
  conversationId: string,
  userId: string,
  draftId: string,
  input: Pick<
    ProductionGenerationDraftInput,
    'prompt' | 'model' | 'params' | 'video' | 'references'
  > & { draftRevision: number },
): Promise<ProductionGenerationView> {
  await readProduction(conversationId, userId)
  const [draft] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.conversation_id, conversationId)))
    .limit(1)
  if (!draft?.submission.production) throw new ProductionError('production_not_found')
  if (draft.task_id || (draft.submission.productionDraftRevision ?? 1) !== input.draftRevision)
    throw new ProductionError('production_conflict')
  const target = resolveQueueModel(draft.media, input.model)
  if (
    !target ||
    (draft.media === 'image' && input.video) ||
    !input.prompt.trim() ||
    input.prompt.length > 8000
  )
    throw new ProductionError('production_invalid')
  if (
    !(await validateProductionMediaReferences(
      conversationId,
      userId,
      input.references.map((item) => item.reference),
    ))
  )
    throw new ProductionError('production_invalid')
  if (draft.media === 'video') validateVideoInput(input)
  else validateImageParameters(input.model, target.provider, input.params, input.references.length)
  const prefix = `${draftId}/in/edit-${crypto.randomUUID()}`
  try {
    const inputImages = await Promise.all(
      input.references.map((item) => referenceDataUrl(conversationId, userId, item.reference)),
    )
    const request = await archiveInputImages(prefix, {
      prompt: input.prompt,
      ...(draft.media === 'image' ? queueParamsFor(target.provider, input.params) : {}),
      ...(input.video ? { video: input.video } : {}),
      n: 1,
      ...(inputImages.length ? { input_images: inputImages } : {}),
    })
    await updateProductionRecord(conversationId, userId, async (record, tx) => {
      const [current] = await tx
        .select()
        .from(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.conversation_id, conversationId)))
        .for('update')
        .limit(1)
      if (!current?.submission.production) throw new ProductionError('production_not_found')
      if (
        current.task_id ||
        (current.submission.productionDraftRevision ?? 1) !== input.draftRevision
      )
        throw new ProductionError('production_conflict')
      targetSnapshot(record.document.content, current.submission.production)
      if (
        !(await validateProductionMediaReferences(
          conversationId,
          userId,
          input.references.map((item) => item.reference),
          tx,
        ))
      )
        throw new ProductionError('production_invalid')
      await tx
        .update(drafts)
        .set({
          prompt: input.prompt,
          model: target.model,
          provider: target.provider,
          request,
          submission: {
            ...current.submission,
            productionDraftRevision: input.draftRevision + 1,
            ...(input.video
              ? {
                  videoRecord: {
                    model: input.model,
                    duration: input.video.duration_seconds,
                    aspectRatio: input.video.aspect_ratio,
                    resolution: input.video.resolution,
                  },
                }
              : {}),
            productionParams: input.params,
            productionReferences: input.references,
          },
        })
        .where(eq(drafts.id, draftId))
      const messages = await tx
        .select()
        .from(schema.agent_messages)
        .where(
          and(
            eq(schema.agent_messages.conversation_id, conversationId),
            eq(schema.agent_messages.turn_id, current.turn_id),
          ),
        )
      for (const message of messages) {
        if (
          !message.content.some(
            (block) => block.type === 'toolResult' && block.toolCallId === current.tool_call_id,
          )
        )
          continue
        await tx
          .update(schema.agent_messages)
          .set({
            content: message.content.map((block) =>
              block.type === 'toolResult' && block.toolCallId === current.tool_call_id
                ? {
                    ...block,
                    productionDraftRevision: input.draftRevision + 1,
                    prompt: input.prompt,
                    ...(block.snapshot
                      ? {
                          snapshot: {
                            ...block.snapshot,
                            target,
                            params: input.params,
                            args: {
                              ...block.snapshot.args,
                              prompt: input.prompt,
                              ...(input.video ? { video: input.video } : {}),
                            },
                          },
                        }
                      : {}),
                  }
                : block,
            ),
          })
          .where(
            and(
              eq(schema.agent_messages.id, message.id),
              eq(schema.agent_messages.conversation_id, conversationId),
            ),
          )
      }
      return record
    })
  } catch (error) {
    await objectStore()
      .deletePrefix(`${prefix}/in/`)
      .catch(() => {})
    if (error instanceof ProductionError) throw error
    throw new ProductionError('production_invalid')
  }
  return (await listProductionGenerations(conversationId, userId)).find(
    (item) => item.draftId === draftId,
  )!
}

export async function adoptProductionGeneration(
  conversationId: string,
  userId: string,
  draftId: string,
  input: { operationId: string; baseRevision: number; artifactId: string },
) {
  return updateProductionRecord(conversationId, userId, async (record, tx) => {
    const [draft] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.conversation_id, conversationId)))
      .limit(1)
    const binding = draft?.submission.production
    const artifact = parseProjectArtifactId(input.artifactId)
    if (
      !draft ||
      !binding ||
      !artifact ||
      artifact.generationId !== draft.task_id ||
      binding.documentId !== record.document.id
    )
      throw new ProductionError('production_not_found')
    if (
      !(await validateProductionMediaReferences(
        conversationId,
        userId,
        [{ kind: 'artifact', artifactId: input.artifactId }],
        tx,
        binding.target === 'clip' ? 'video' : 'image',
      ))
    )
      throw new ProductionError('production_invalid')
    const content = record.history.find(
      (revision) => revision.revision === input.baseRevision,
    )?.content
    if (!content) throw new ProductionError('production_conflict', record.document)
    targetSnapshot(content, binding, false)
    const reference = { kind: 'artifact' as const, artifactId: input.artifactId }
    const adoptedAt =
      record.history
        .flatMap((revision) => revision.content.clips ?? [])
        .find(
          (clip) =>
            clip.id === binding.targetId &&
            clip.adopted?.draftId === draftId &&
            clip.adopted.artifactId === input.artifactId,
        )?.adopted?.adoptedAt ?? Date.now()
    const nextContent =
      binding.target === 'clip'
        ? {
            ...content,
            clips: content.clips?.map((clip) =>
              clip.id === binding.targetId
                ? { ...clip, adopted: { draftId, artifactId: input.artifactId, adoptedAt } }
                : clip,
            ),
          }
        : binding.target === 'look'
          ? {
              ...content,
              characters: content.characters?.map((character) => ({
                ...character,
                looks: character.looks.map((look) =>
                  look.id === binding.targetId ? { ...look, reference } : look,
                ),
              })),
            }
          : {
              ...content,
              locations: content.locations?.map((location) =>
                location.id === binding.targetId ? { ...location, reference } : location,
              ),
            }
    return applyProductionMutation(
      record,
      {
        operationId: `adopt:${input.operationId}`,
        baseRevision: input.baseRevision,
        content: nextContent,
      },
      'agent',
      conversationId,
      record.document.projectId,
      draft.turn_id,
    )
  })
}
