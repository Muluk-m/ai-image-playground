import { createHash, randomUUID } from 'node:crypto'
import type {
  InspirationAdminItem,
  InspirationCategory,
  InspirationItem,
  InspirationManifest,
  InspirationReferenceInput,
  InspirationWriteInput,
} from '@image-playground/shared'
import { and, asc, desc, eq, ilike, max, or, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { agentSkills, ensureAgentSkills } from './agent/skills'
import { getChannels } from './channels'

export type InspirationOperationErrorCode =
  | 'item_not_found'
  | 'category_not_found'
  | 'category_in_use'
  | 'invalid_item'
  | 'invalid_template'
  | 'invalid_skill'
  | 'invalid_model'
  | 'published_item_must_be_archived'
  | 'id_taken'
  | 'category_name_taken'

export class InspirationOperationError extends Error {
  constructor(readonly code: InspirationOperationErrorCode) {
    super(code)
    this.name = 'InspirationOperationError'
  }
}

const publicAssetUrl = (key: string): string => {
  if (/^https?:\/\//.test(key)) return key
  const base = config.publicAssets.baseUrl
  if (!base) throw new Error('PUBLIC_ASSET_BASE_URL is required for stored inspiration assets')
  return `${base}/${key.replace(/^\/+/, '')}`
}

const slotsOf = (prompt: string): string[] => {
  const slots = [...prompt.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean)
  return [...new Set(slots)]
}

function rowToAdmin(row: typeof schema.inspiration_items.$inferSelect): InspirationAdminItem {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    featured: row.featured,
    title: row.title,
    description: row.description,
    categoryId: row.category_id,
    prompt: row.prompt,
    recommendedProvider: row.recommended_provider,
    recommendedModel: row.recommended_model,
    params: row.params,
    tags: row.tags,
    coverKey: row.cover_key,
    imageKey: row.image_key,
    referenceImages: row.reference_images,
    skillName: row.skill_name,
    sourceUrl: row.source_url,
    author: row.author,
    sort: row.sort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    publishedAt: row.published_at,
  }
}

function rowToManifest(
  row: typeof schema.inspiration_items.$inferSelect,
  category: string,
): InspirationItem {
  const slots = row.kind === 'template' ? slotsOf(row.prompt) : []
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    prompt: row.prompt,
    thumbnailUrl: publicAssetUrl(row.cover_key),
    ...(row.image_key ? { imageUrl: publicAssetUrl(row.image_key) } : {}),
    params: row.params,
    recommendedModel: row.recommended_model,
    recommendedProvider: row.recommended_provider,
    category,
    ...(row.tags.length ? { tags: row.tags } : {}),
    ...(row.author ? { author: row.author } : {}),
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    ...(row.featured ? { featured: true } : {}),
    ...(row.reference_images.length
      ? {
          referenceImages: row.reference_images.map((reference) => ({
            name: reference.name,
            url: publicAssetUrl(reference.key),
          })),
        }
      : {}),
    ...(row.skill_name ? { skill: row.skill_name } : {}),
    ...(slots.length ? { slots } : {}),
  }
}

const categoryView = (
  row: typeof schema.inspiration_categories.$inferSelect,
): InspirationCategory => ({
  id: row.id,
  name: row.name,
  sort: row.sort,
})

async function publishedContent(executor: Pick<typeof db, 'select'>): Promise<{
  items: InspirationItem[]
  categories: string[]
}> {
  const rows = await executor
    .select({
      item: schema.inspiration_items,
      category: schema.inspiration_categories.name,
      categoryId: schema.inspiration_categories.id,
      categorySort: schema.inspiration_categories.sort,
    })
    .from(schema.inspiration_items)
    .innerJoin(
      schema.inspiration_categories,
      eq(schema.inspiration_items.category_id, schema.inspiration_categories.id),
    )
    .where(eq(schema.inspiration_items.status, 'published'))
    .orderBy(
      asc(schema.inspiration_items.sort),
      asc(schema.inspiration_items.published_at),
      asc(schema.inspiration_items.id),
    )
  const categories = [
    ...new Map(
      rows.map(({ category, categoryId, categorySort }) => [
        categoryId,
        { name: category, sort: categorySort },
      ]),
    ).values(),
  ]
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map(({ name }) => name)
  return {
    items: rows.map(({ item, category }) => rowToManifest(item, category)),
    categories,
  }
}

export async function refreshPublication(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('inspiration-publication'))`)
  const content = await publishedContent(tx)
  const manifestHash = createHash('sha256').update(JSON.stringify(content)).digest('hex')
  const [latest] = await tx
    .select()
    .from(schema.inspiration_publications)
    .orderBy(desc(schema.inspiration_publications.version))
    .limit(1)
  if (latest?.manifest_hash === manifestHash) return latest
  const [maximum] = await tx
    .select({ version: max(schema.inspiration_publications.version) })
    .from(schema.inspiration_publications)
  const publication = {
    version: (maximum?.version ?? 0) + 1,
    published_at: Date.now(),
    item_count: content.items.length,
    manifest_hash: manifestHash,
  }
  await tx.insert(schema.inspiration_publications).values(publication)
  return publication
}

function validateWriteInput(input: InspirationWriteInput): void {
  if (
    !input.id.trim() ||
    !input.title.trim() ||
    !input.categoryId.trim() ||
    !input.prompt.trim() ||
    !input.recommendedProvider.trim() ||
    !input.recommendedModel.trim() ||
    !input.coverKey.trim() ||
    !input.params.size.trim()
  ) {
    throw new InspirationOperationError('invalid_item')
  }
  if (input.kind === 'template' && slotsOf(input.prompt).length === 0) {
    throw new InspirationOperationError('invalid_template')
  }
  if (input.kind === 'skill' && !input.skillName?.trim()) {
    throw new InspirationOperationError('invalid_skill')
  }
}

async function validateForPublish(input: InspirationWriteInput): Promise<void> {
  validateWriteInput(input)
  const providerKind =
    input.recommendedProvider === 'openai-compat'
      ? 'openai-queue'
      : input.recommendedProvider === 'gemini'
        ? 'gemini-queue'
        : input.recommendedProvider
  const modelAvailable = getChannels().some(
    (channel) =>
      channel.kind === providerKind &&
      channel.models.some(
        (model) => model.id === input.recommendedModel && model.media !== 'video',
      ),
  )
  if (!modelAvailable) throw new InspirationOperationError('invalid_model')
  if (input.kind !== 'skill') return
  await ensureAgentSkills()
  if (!input.skillName || !agentSkills('image').some((skill) => skill.name === input.skillName)) {
    throw new InspirationOperationError('invalid_skill')
  }
}

const writeColumns = (input: InspirationWriteInput, now: number, operatorId: string) => ({
  id: input.id.trim(),
  kind: input.kind,
  featured: input.featured,
  title: input.title.trim(),
  description: input.description?.trim() || null,
  category_id: input.categoryId,
  prompt: input.prompt.trim(),
  recommended_provider: input.recommendedProvider.trim(),
  recommended_model: input.recommendedModel.trim(),
  params: input.params,
  tags: input.tags.map((tag) => tag.trim()).filter(Boolean),
  cover_key: input.coverKey.trim(),
  image_key: input.imageKey?.trim() || null,
  reference_images: input.referenceImages
    .map((reference: InspirationReferenceInput) => ({
      key: reference.key.trim(),
      name: reference.name.trim(),
    }))
    .filter((reference) => reference.key && reference.name),
  skill_name: input.kind === 'skill' ? input.skillName?.trim() || null : null,
  source_url: input.sourceUrl?.trim() || null,
  author: input.author?.trim() || null,
  sort: input.sort,
  updated_at: now,
  updated_by: operatorId,
})

const audit = (action: string, targetId: string, operatorId: string, details = {}) => ({
  id: randomUUID(),
  operator_id: operatorId,
  action,
  target_type: 'inspiration',
  target_id: targetId,
  details,
  created_at: Date.now(),
})

export async function listInspirationCategories(): Promise<InspirationCategory[]> {
  const rows = await db
    .select()
    .from(schema.inspiration_categories)
    .orderBy(asc(schema.inspiration_categories.sort), asc(schema.inspiration_categories.name))
  return rows.map(categoryView)
}

export async function createInspirationCategory(
  input: InspirationCategory,
  operatorId = 'admin',
): Promise<InspirationCategory> {
  const now = Date.now()
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.inspiration_categories)
        .values({
          id: input.id.trim(),
          name: input.name.trim(),
          sort: input.sort,
          created_at: now,
          updated_at: now,
        })
        .returning()
      if (!created) throw new Error('created category missing')
      await tx
        .insert(schema.operator_audits)
        .values(
          audit('inspiration.category.create', created.id, operatorId, { name: created.name }),
        )
      await refreshPublication(tx)
      return categoryView(created)
    })
  } catch (error) {
    if (String((error as { cause?: { errno?: unknown } })?.cause?.errno) === '23505') {
      throw new InspirationOperationError('category_name_taken')
    }
    throw error
  }
}

export async function updateInspirationCategory(
  id: string,
  input: Pick<InspirationCategory, 'name' | 'sort'>,
  operatorId = 'admin',
): Promise<InspirationCategory> {
  try {
    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.inspiration_categories)
        .set({ name: input.name.trim(), sort: input.sort, updated_at: Date.now() })
        .where(eq(schema.inspiration_categories.id, id))
        .returning()
      if (!updated) throw new InspirationOperationError('category_not_found')
      await tx.insert(schema.operator_audits).values(
        audit('inspiration.category.update', id, operatorId, {
          name: updated.name,
          sort: updated.sort,
        }),
      )
      await refreshPublication(tx)
      return categoryView(updated)
    })
  } catch (error) {
    if (String((error as { cause?: { errno?: unknown } })?.cause?.errno) === '23505') {
      throw new InspirationOperationError('category_name_taken')
    }
    throw error
  }
}

export async function deleteInspirationCategory(id: string, operatorId = 'admin'): Promise<void> {
  await db.transaction(async (tx) => {
    const [used] = await tx
      .select({ id: schema.inspiration_items.id })
      .from(schema.inspiration_items)
      .where(eq(schema.inspiration_items.category_id, id))
      .limit(1)
    if (used) throw new InspirationOperationError('category_in_use')
    const deleted = await tx
      .delete(schema.inspiration_categories)
      .where(eq(schema.inspiration_categories.id, id))
      .returning({ id: schema.inspiration_categories.id })
    if (!deleted.length) throw new InspirationOperationError('category_not_found')
    await tx
      .insert(schema.operator_audits)
      .values(audit('inspiration.category.delete', id, operatorId))
    await refreshPublication(tx)
  })
}

export async function listInspirationItems(
  filter: { status?: string; kind?: string; q?: string } = {},
): Promise<InspirationAdminItem[]> {
  const conditions = []
  if (filter.status && filter.status !== 'all') {
    conditions.push(
      eq(schema.inspiration_items.status, filter.status as InspirationAdminItem['status']),
    )
  }
  if (filter.kind && filter.kind !== 'all') {
    conditions.push(eq(schema.inspiration_items.kind, filter.kind as InspirationAdminItem['kind']))
  }
  if (filter.q?.trim()) {
    const query = `%${filter.q.trim()}%`
    conditions.push(
      or(ilike(schema.inspiration_items.title, query), ilike(schema.inspiration_items.id, query))!,
    )
  }
  const rows = await db
    .select()
    .from(schema.inspiration_items)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(schema.inspiration_items.sort), desc(schema.inspiration_items.updated_at))
  return rows.map(rowToAdmin)
}

export async function getInspirationItem(id: string): Promise<InspirationAdminItem | null> {
  const [row] = await db
    .select()
    .from(schema.inspiration_items)
    .where(eq(schema.inspiration_items.id, id))
    .limit(1)
  return row ? rowToAdmin(row) : null
}

export async function createInspirationItem(
  input: InspirationWriteInput,
  operatorId = 'admin',
): Promise<InspirationAdminItem> {
  validateWriteInput(input)
  const now = Date.now()
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.inspiration_items)
        .values({ ...writeColumns(input, now, operatorId), status: 'draft', created_at: now })
        .returning()
      if (!created) throw new Error('created inspiration missing')
      await tx
        .insert(schema.operator_audits)
        .values(audit('inspiration.create', created.id, operatorId, { kind: created.kind }))
      return rowToAdmin(created)
    })
  } catch (error) {
    if (String((error as { cause?: { errno?: unknown } })?.cause?.errno) === '23505') {
      throw new InspirationOperationError('id_taken')
    }
    if (String((error as { cause?: { errno?: unknown } })?.cause?.errno) === '23503') {
      throw new InspirationOperationError('category_not_found')
    }
    throw error
  }
}

export async function updateInspirationItem(
  id: string,
  input: InspirationWriteInput,
  operatorId = 'admin',
): Promise<InspirationAdminItem> {
  if (input.id !== id) throw new InspirationOperationError('invalid_item')
  validateWriteInput(input)
  const existing = await getInspirationItem(id)
  if (!existing) throw new InspirationOperationError('item_not_found')
  if (existing.status === 'published') await validateForPublish(input)
  try {
    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.inspiration_items)
        .set(writeColumns(input, Date.now(), operatorId))
        .where(eq(schema.inspiration_items.id, id))
        .returning()
      if (!updated) throw new InspirationOperationError('item_not_found')
      await tx.insert(schema.operator_audits).values(audit('inspiration.update', id, operatorId))
      await refreshPublication(tx)
      return rowToAdmin(updated)
    })
  } catch (error) {
    if (String((error as { cause?: { errno?: unknown } })?.cause?.errno) === '23503') {
      throw new InspirationOperationError('category_not_found')
    }
    throw error
  }
}

export async function deleteInspirationItem(id: string, operatorId = 'admin'): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: schema.inspiration_items.status })
      .from(schema.inspiration_items)
      .where(eq(schema.inspiration_items.id, id))
      .limit(1)
    if (!current) throw new InspirationOperationError('item_not_found')
    if (current.status === 'published') {
      throw new InspirationOperationError('published_item_must_be_archived')
    }
    await tx.delete(schema.inspiration_items).where(eq(schema.inspiration_items.id, id))
    await tx.insert(schema.operator_audits).values(audit('inspiration.delete', id, operatorId))
  })
}

export async function setInspirationStatus(
  id: string,
  status: InspirationAdminItem['status'],
  operatorId = 'admin',
): Promise<InspirationAdminItem> {
  const current = await getInspirationItem(id)
  if (!current) throw new InspirationOperationError('item_not_found')
  if (status === 'published') await validateForPublish(current)
  return db.transaction(async (tx) => {
    const now = Date.now()
    const [updated] = await tx
      .update(schema.inspiration_items)
      .set({
        status,
        updated_at: now,
        updated_by: operatorId,
        published_at: status === 'published' ? (current.publishedAt ?? now) : current.publishedAt,
      })
      .where(eq(schema.inspiration_items.id, id))
      .returning()
    if (!updated) throw new InspirationOperationError('item_not_found')
    await tx.insert(schema.operator_audits).values(audit(`inspiration.${status}`, id, operatorId))
    await refreshPublication(tx)
    return rowToAdmin(updated)
  })
}

export async function publicInspirationManifest(): Promise<InspirationManifest> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('inspiration-publication'))`)
    const [publication] = await tx
      .select()
      .from(schema.inspiration_publications)
      .orderBy(desc(schema.inspiration_publications.version))
      .limit(1)
    const content = await publishedContent(tx)
    return {
      version: publication?.version ?? 0,
      updatedAt: new Date(publication?.published_at ?? 0).toISOString(),
      ...content,
    }
  })
}
