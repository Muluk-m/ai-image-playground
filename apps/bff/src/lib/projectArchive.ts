import {
  AGENT_IMAGE_MAX_N,
  isProjectDocument,
  PROJECT_DOCUMENT_MAX_BYTES,
  type ProjectElement,
  type ProjectGeneration,
  projectArtifactId,
} from '@image-playground/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { schema } from '../db/client'
import type { BffTransaction } from './private-overlay'
import { lockMediaOwner } from './projectMedia'

export async function reserveProjectOutputs(
  tx: BffTransaction,
  input: {
    userId: string
    generationId: string
    conversationId: string
    turnId: string
    count: number
  },
) {
  if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > AGENT_IMAGE_MAX_N)
    throw new Error('invalid_output_count')
  const [project] = await tx
    .select()
    .from(schema.canvas_projects)
    .where(
      and(
        eq(schema.canvas_projects.user_id, input.userId),
        eq(schema.canvas_projects.conversation_id, input.conversationId),
      ),
    )
  if (!project) return
  const right = Math.max(
    0,
    ...project.document.elements.map((element) =>
      'x' in element
        ? element.x + element.width
        : Math.max(0, ...element.points.filter((_, index) => index % 2 === 0)),
    ),
  )
  const outputs: ProjectGeneration[] = Array.from({ length: input.count }, (_, position) => ({
    id: projectArtifactId(input.generationId, position),
    type: 'generation',
    generationId: input.generationId,
    position,
    x: right + 24 + position * 384,
    y: 0,
    width: 360,
    height: 360,
  }))
  const document = { version: 1, elements: [...project.document.elements, ...outputs] }
  if (
    !isProjectDocument(document) ||
    Buffer.byteLength(JSON.stringify(document)) > PROJECT_DOCUMENT_MAX_BYTES
  )
    throw new Error('项目画布已满，请清理画布后再生成')
  await tx.insert(schema.project_generation_outputs).values(
    outputs.map((output) => ({
      generation_id: input.generationId,
      position: output.position,
      user_id: input.userId,
      project_id: project.id,
      conversation_id: input.conversationId,
      turn_id: input.turnId,
      object_id: output.id,
    })),
  )
  await tx
    .update(schema.canvas_projects)
    .set({
      document,
      revision: project.revision + 1,
      element_count: document.elements.length,
      updated_at: Date.now(),
    })
    .where(eq(schema.canvas_projects.id, project.id))
}

export async function publishProjectOutputs(
  tx: BffTransaction,
  userId: string,
  generationId: string,
  links: readonly { role: string; position: number; mediaId: string }[],
) {
  const outputs = await tx
    .select()
    .from(schema.project_generation_outputs)
    .where(
      and(
        eq(schema.project_generation_outputs.generation_id, generationId),
        eq(schema.project_generation_outputs.user_id, userId),
      ),
    )
  if (!outputs.length) return
  await lockMediaOwner(tx, userId)
  const [project] = await tx
    .select()
    .from(schema.canvas_projects)
    .where(
      and(
        eq(schema.canvas_projects.id, outputs[0]!.project_id),
        eq(schema.canvas_projects.user_id, userId),
      ),
    )
  if (!project) return
  const mediaIds = links.filter((link) => link.role === 'output').map((link) => link.mediaId)
  const media = mediaIds.length
    ? await tx
        .select({
          id: schema.media_objects.id,
          status: schema.media_objects.status,
          width: schema.media_objects.width,
          height: schema.media_objects.height,
        })
        .from(schema.media_objects)
        .where(
          and(eq(schema.media_objects.user_id, userId), inArray(schema.media_objects.id, mediaIds)),
        )
    : []
  const placed: string[] = []
  let touched = false
  let elements: ProjectElement[] = project.document.elements.flatMap((element) => {
    if (element.type !== 'generation' || element.generationId !== generationId) return [element]
    const reserved = outputs.find(
      (output) => output.object_id === element.id && output.position === element.position,
    )
    if (!reserved) return [element]
    touched = true
    const link = links.find((link) => link.role === 'output' && link.position === reserved.position)
    const asset = link && media.find((one) => one.id === link.mediaId && one.status === 'ready')
    if (!asset) return []
    placed.push(asset.id)
    return [
      {
        id: element.id,
        type: 'image' as const,
        mediaId: asset.id,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        rotation: 0,
        ...(asset.width ? { naturalWidth: asset.width } : {}),
        ...(asset.height ? { naturalHeight: asset.height } : {}),
        groupId: generationId,
      },
    ]
  })
  if (!touched) return
  if (
    !isProjectDocument({ version: 1, elements }) ||
    Buffer.byteLength(JSON.stringify({ version: 1, elements })) > PROJECT_DOCUMENT_MAX_BYTES
  ) {
    // 画布装不下时原件仍归档到创作记录；只收掉本任务的预留位置。
    elements = project.document.elements.filter(
      (element) => element.type !== 'generation' || element.generationId !== generationId,
    )
    placed.length = 0
  }
  if (placed.length)
    await tx
      .insert(schema.media_references)
      .values(
        [...new Set(placed)].map((mediaId) => ({
          user_id: userId,
          media_id: mediaId,
          owner_kind: 'project' as const,
          owner_id: project.id,
          created_at: Date.now(),
        })),
      )
      .onConflictDoNothing()
  await tx
    .update(schema.canvas_projects)
    .set({
      document: { version: 1, elements },
      revision: project.revision + 1,
      element_count: elements.length,
      cover_media_id:
        elements.filter((element) => element.type === 'image').at(-1)?.mediaId ?? null,
      updated_at: Date.now(),
    })
    .where(eq(schema.canvas_projects.id, project.id))
}
