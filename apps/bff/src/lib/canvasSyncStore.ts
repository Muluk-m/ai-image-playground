import {
  type CloudProjectSummary,
  canvasNodeJobs,
  canvasOrigin,
  canvasProjectDocument,
  canvasResultMediaIds,
  canvasResults,
  copiedCanvasProjectName,
  importLegacyElements,
  initializeCanvasConnectionRules,
  initializeCanvasTexts,
  type ProjectDocument,
  readCanvasDocument,
  synchronizeLegacyElements,
  validateCloudCanvas,
} from '@image-playground/shared'
import { and, asc, count, eq, inArray, lte, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { config } from '../config'
import { db, schema } from '../db/client'
import type { BffTransaction } from './private-overlay'

export class CanvasSyncError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410 | 413,
    message: string,
  ) {
    super(message)
  }
}
const origin = canvasOrigin('system', 'cloud-archive')
const documents = schema.canvas_documents
const updates = schema.canvas_updates
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const decode = (value: string) => new Uint8Array(Buffer.from(value, 'base64'))

async function load(tx: BffTransaction, projectId: string) {
  const [row] = await tx.select().from(documents).where(eq(documents.project_id, projectId))
  if (!row) return null
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, decode(row.snapshot))
    const log = await tx
      .select()
      .from(updates)
      .where(eq(updates.project_id, projectId))
      .orderBy(asc(updates.sequence))
    for (const item of log) Y.applyUpdate(doc, decode(item.update))
    return { doc, row }
  } catch (error) {
    doc.destroy()
    throw error
  }
}

async function persist(
  tx: BffTransaction,
  projectId: string,
  loaded: NonNullable<Awaited<ReturnType<typeof load>>>,
  delta: Uint8Array,
) {
  const now = Date.now()
  const sequence = loaded.row.sequence + 1
  await tx
    .insert(updates)
    .values({ project_id: projectId, sequence, update: base64(delta), created_at: now })
  // Bound replay cost by both age and number of updates; rows are removed in the snapshot transaction.
  const compact =
    sequence - loaded.row.compacted_sequence >= 128 || now - loaded.row.compacted_at >= 300_000
  await tx
    .update(documents)
    .set({
      sequence,
      ...(compact
        ? {
            snapshot: base64(Y.encodeStateAsUpdate(loaded.doc)),
            compacted_sequence: sequence,
            compacted_at: now,
          }
        : {}),
    })
    .where(eq(documents.project_id, projectId))
  if (compact)
    await tx
      .delete(updates)
      .where(and(eq(updates.project_id, projectId), lte(updates.sequence, sequence)))
  loaded.row.sequence = sequence
  if (compact) {
    loaded.row.compacted_sequence = sequence
    loaded.row.compacted_at = now
  }
  await tx.execute(sql`SELECT pg_notify('canvas_changed', ${projectId})`)
}

/** Caller holds the user row lock, shared with project/media/archive writes. */
export async function syncLegacyCanvasWrite(
  tx: BffTransaction,
  projectId: string,
  previous: ProjectDocument,
  next: ProjectDocument,
): Promise<void> {
  const loaded = await load(tx, projectId)
  if (!loaded) return
  try {
    const vector = Y.encodeStateVector(loaded.doc)
    synchronizeLegacyElements(loaded.doc, previous.elements, next.elements, origin)
    await persist(tx, projectId, loaded, Y.encodeStateAsUpdate(loaded.doc, vector))
  } finally {
    loaded.doc.destroy()
  }
}

function referencedTasks(doc: Y.Doc): Set<string> {
  const tasks = new Set<string>(
    canvasResults(doc).flatMap((result) => [
      ...(result.source.type === 'queue' &&
      !(
        result.display?.video?.mediaId &&
        result.display.video.taskId === result.source.taskId &&
        result.display.video.outputIndex === result.source.outputIndex
      )
        ? [result.source.taskId]
        : []),
      ...(result.display?.video && !result.display.video.mediaId
        ? [result.display.video.taskId]
        : []),
    ]),
  )
  for (const job of canvasNodeJobs(doc)) if (job.meta.bffRequestId) tasks.add(job.meta.bffRequestId)
  for (const node of readCanvasDocument(doc).nodes) {
    if ('video' in node.data && !node.data.video.mediaId) tasks.add(node.data.video.taskId)
    if ('pending' in node.data && node.data.pending?.type === 'placeholder') {
      const meta = node.data.pending.meta
      if ('bffRequestId' in meta && typeof meta.bffRequestId === 'string')
        tasks.add(meta.bffRequestId)
    }
  }
  return tasks
}

async function validateOwnership(
  tx: BffTransaction,
  userId: string,
  projectId: string,
  doc: Y.Doc,
  acceptedTasks: ReadonlySet<string>,
) {
  const { nodes } = readCanvasDocument(doc)
  const videoMediaIds = new Set([
    ...nodes.flatMap((n) =>
      'video' in n.data && n.data.video.mediaId ? [n.data.video.mediaId] : [],
    ),
    ...canvasResults(doc).flatMap((r) =>
      r.display?.video?.mediaId ? [r.display.video.mediaId] : [],
    ),
  ])
  const mediaIds = [
    ...new Set([
      ...nodes.flatMap((n) => [
        ...('mediaId' in n.data && n.data.mediaId ? [n.data.mediaId] : []),
        ...('video' in n.data && n.data.video.mediaId ? [n.data.video.mediaId] : []),
      ]),
      ...canvasResultMediaIds(doc),
    ]),
  ]
  if (mediaIds.length) {
    const owned = await tx
      .select({ id: schema.media_objects.id, contentType: schema.media_objects.content_type })
      .from(schema.media_objects)
      .where(
        and(
          eq(schema.media_objects.user_id, userId),
          eq(schema.media_objects.status, 'ready'),
          inArray(schema.media_objects.id, mediaIds),
        ),
      )
    if (owned.length !== mediaIds.length) throw new CanvasSyncError(403, 'canvas_media_not_owned')
    if (owned.some((media) => videoMediaIds.has(media.id) && media.contentType !== 'video/mp4'))
      throw new CanvasSyncError(400, 'canvas_video_media_invalid')
  }
  const tasks = referencedTasks(doc)
  const generationIds = new Set<string>()
  for (const node of nodes) {
    if ('video' in node.data && !node.data.video.mediaId) tasks.add(node.data.video.taskId)
    if ('pending' in node.data && node.data.pending) {
      const pending = node.data.pending
      if (pending.type === 'generation') generationIds.add(pending.generationId)
      if (pending.type === 'placeholder' && pending.meta && 'bffRequestId' in pending.meta) {
        if (typeof pending.meta.bffRequestId !== 'string')
          throw new CanvasSyncError(400, 'invalid_canvas_pending')
        tasks.add(pending.meta.bffRequestId)
      }
    }
  }
  // Accepted references outlive the queue retention window. Only new references need a live task.
  for (const taskId of acceptedTasks) tasks.delete(taskId)
  if (tasks.size) {
    const owned = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.user_id, userId), inArray(schema.tasks.id, [...tasks])))
    if (owned.length !== tasks.size) throw new CanvasSyncError(403, 'canvas_task_not_owned')
  }
  if (generationIds.size) {
    const owned = await tx
      .select()
      .from(schema.project_generation_outputs)
      .where(
        and(
          eq(schema.project_generation_outputs.user_id, userId),
          eq(schema.project_generation_outputs.project_id, projectId),
          inArray(schema.project_generation_outputs.generation_id, [...generationIds]),
        ),
      )
    for (const node of nodes) {
      if (!('pending' in node.data) || node.data.pending?.type !== 'generation') continue
      const pending = node.data.pending
      if (
        !owned.some(
          (one) =>
            one.object_id === node.id &&
            one.generation_id === pending.generationId &&
            one.position === pending.position,
        )
      )
        throw new CanvasSyncError(403, 'canvas_output_not_owned')
    }
  }
}

/** Every accepted update is validated on an isolated candidate, persisted, then published. */
export async function accessCanvasDocument(
  userId: string,
  projectId: string,
  change?: Uint8Array | ((doc: Y.Doc, tx: BffTransaction) => Promise<Uint8Array | undefined>),
): Promise<Uint8Array> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update')
    const [project] = await tx
      .select()
      .from(schema.canvas_projects)
      .where(
        and(eq(schema.canvas_projects.id, projectId), eq(schema.canvas_projects.user_id, userId)),
      )
    if (!project) throw new CanvasSyncError(404, 'project_not_found')
    if (project.deleted_at !== null) throw new CanvasSyncError(410, 'project_deleted')
    let loaded = await load(tx, projectId)
    if (!loaded) {
      const doc = new Y.Doc()
      importLegacyElements(doc, project.document.elements, origin)
      const now = Date.now()
      const [row] = await tx
        .insert(documents)
        .values({
          project_id: projectId,
          snapshot: base64(Y.encodeStateAsUpdate(doc)),
          legacy_document: project.document,
          migrated_at: now,
          compacted_at: now,
        })
        .returning()
      loaded = { doc, row: row! }
    }
    const { doc } = loaded
    try {
      const policyVector = Y.encodeStateVector(doc)
      const textMigrated = initializeCanvasTexts(doc)
      if (initializeCanvasConnectionRules(doc) || textMigrated)
        await persist(tx, projectId, loaded, Y.encodeStateAsUpdate(doc, policyVector))
      const legacyConnections = doc.getMap<string>('legacyConnections').toJSON()
      const update = typeof change === 'function' ? await change(doc, tx) : change
      if (update) {
        const vector = Y.encodeStateVector(doc)
        const before = Y.encodeStateAsUpdate(doc)
        const acceptedTasks = referencedTasks(doc)
        try {
          Y.applyUpdate(doc, update)
          validateCloudCanvas(doc, project.document, legacyConnections)
        } catch {
          throw new CanvasSyncError(400, 'invalid_canvas_document')
        }
        await validateOwnership(tx, userId, projectId, doc, acceptedTasks)
        const after = Y.encodeStateAsUpdate(doc)
        if (!Buffer.from(before).equals(Buffer.from(after))) {
          await persist(tx, projectId, loaded, Y.encodeStateAsUpdate(doc, vector))
          const document = canvasProjectDocument(doc, project.document)
          const mediaIds = [
            ...new Set([
              ...document.elements.flatMap((el) =>
                el.type === 'image'
                  ? [el.mediaId, ...(el.video?.mediaId ? [el.video.mediaId] : [])]
                  : [],
              ),
              ...canvasResultMediaIds(doc),
            ]),
          ]
          // Retain old media references for the migration archive; active references are additive.
          if (mediaIds.length)
            await tx
              .insert(schema.media_references)
              .values(
                mediaIds.map((media_id) => ({
                  user_id: userId,
                  media_id,
                  owner_kind: 'project' as const,
                  owner_id: projectId,
                  created_at: Date.now(),
                })),
              )
              .onConflictDoNothing()
          await tx
            .update(schema.canvas_projects)
            .set({
              document,
              revision: project.revision + 1,
              element_count: readCanvasDocument(doc).nodes.length,
              cover_media_id:
                document.elements.filter((el) => el.type === 'image').at(-1)?.mediaId ?? null,
              updated_at: Date.now(),
              receipts: [],
            })
            .where(eq(schema.canvas_projects.id, projectId))
        }
      }
      return Y.encodeStateAsUpdate(doc)
    } finally {
      doc.destroy()
    }
  })
}

function referencedMediaIds(doc: Y.Doc, document: ProjectDocument): string[] {
  return [
    ...new Set([
      ...document.elements.flatMap((element) =>
        element.type === 'image'
          ? [element.mediaId, ...(element.video?.mediaId ? [element.video.mediaId] : [])]
          : [],
      ),
      ...canvasResultMediaIds(doc),
    ]),
  ]
}

/** Point-in-time copy of the committed canvas. The new project does not share history or conversation. */
export async function copyCanvasProject(
  userId: string,
  sourceId: string,
  suffix?: string,
): Promise<CloudProjectSummary> {
  await accessCanvasDocument(userId, sourceId)
  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update')
    const [project] = await tx
      .select()
      .from(schema.canvas_projects)
      .where(
        and(eq(schema.canvas_projects.id, sourceId), eq(schema.canvas_projects.user_id, userId)),
      )
    if (!project) throw new CanvasSyncError(404, 'project_not_found')
    if (project.deleted_at !== null) throw new CanvasSyncError(410, 'project_deleted')
    const [total] = await tx
      .select({ count: count() })
      .from(schema.canvas_projects)
      .where(eq(schema.canvas_projects.user_id, userId))
    if ((total?.count ?? 0) >= config.operator.quotas['sync:user-projects'])
      throw new CanvasSyncError(413, 'project_quota_exceeded')
    const loaded = await load(tx, sourceId)
    if (!loaded) throw new CanvasSyncError(404, 'project_not_found')
    const copy = new Y.Doc()
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(loaded.doc))
      const now = Date.now()
      const id = crypto.randomUUID()
      // 副本是一张新画布，不保留「返回来源对话」。原件自己的回链留在原件上。
      const { sourceProjectId: _sourceProjectId, ...identity } = project.document
      const document = canvasProjectDocument(copy, identity)
      const snapshot = readCanvasDocument(copy)
      const summary: CloudProjectSummary = {
        id,
        name: copiedCanvasProjectName(project.name, suffix),
        revision: 1,
        createdAt: now,
        updatedAt: now,
        elementCount: snapshot.nodes.length,
        coverMediaId:
          document.elements.filter((element) => element.type === 'image').at(-1)?.mediaId ?? null,
        conversationId: null,
        ...(document.experience ? { experience: document.experience } : {}),
      }
      await tx.insert(schema.canvas_projects).values({
        id,
        user_id: userId,
        name: summary.name,
        revision: summary.revision,
        document,
        element_count: summary.elementCount,
        cover_media_id: summary.coverMediaId,
        conversation_id: null,
        receipts: [],
        created_at: now,
        updated_at: now,
      })
      await tx.insert(documents).values({
        project_id: id,
        snapshot: base64(Y.encodeStateAsUpdate(copy)),
        sequence: 0,
        compacted_sequence: 0,
        compacted_at: now,
        legacy_document: document,
        migrated_at: now,
      })
      const mediaIds = referencedMediaIds(copy, document)
      if (mediaIds.length)
        await tx
          .insert(schema.media_references)
          .values(
            mediaIds.map((media_id) => ({
              user_id: userId,
              media_id,
              owner_kind: 'project' as const,
              owner_id: id,
              created_at: now,
            })),
          )
          .onConflictDoNothing()
      return summary
    } finally {
      copy.destroy()
      loaded.doc.destroy()
    }
  })
}
