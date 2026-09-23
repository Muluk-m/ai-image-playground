import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { runMigrations, schema } from '@image-playground/db'
import { close, db } from '../src/db/client'
import { refreshPublication } from '../src/lib/inspirations'

interface LegacyItem {
  id: string
  title: string
  description?: string
  prompt: string
  thumbnailUrl: string
  imageUrl?: string
  params: { size: string; quality?: 'auto' | 'low' | 'medium' | 'high'; n?: number }
  recommendedModel: string
  recommendedProvider: string
  category: string
  tags?: string[]
  author?: string | null
  sourceUrl?: string
}

interface LegacyManifest {
  version: number
  updatedAt: string
  categories: string[]
  items: LegacyItem[]
}

const FEATURED_IDS: Record<string, true> = {
  'awesome-3': true,
  'awesome-6': true,
  'awesome-8': true,
  'awesome-11': true,
  'awesome-27': true,
  'awesome-182': true,
}

function categoryId(name: string): string {
  return `legacy-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`
}

function parseManifest(raw: string): LegacyManifest {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !('categories' in value) || !('items' in value)) {
    throw new Error('manifest must contain categories and items')
  }
  const categories = value.categories
  const items = value.items
  const updatedAt = 'updatedAt' in value ? value.updatedAt : undefined
  const version = 'version' in value ? value.version : undefined
  if (
    !Array.isArray(categories) ||
    !categories.every((entry) => typeof entry === 'string' && entry.length > 0) ||
    !Array.isArray(items) ||
    typeof updatedAt !== 'string' ||
    typeof version !== 'number'
  ) {
    throw new Error('invalid manifest root')
  }
  for (const entry of items) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('id' in entry) ||
      typeof entry.id !== 'string' ||
      !('title' in entry) ||
      typeof entry.title !== 'string' ||
      !('prompt' in entry) ||
      typeof entry.prompt !== 'string' ||
      !('thumbnailUrl' in entry) ||
      typeof entry.thumbnailUrl !== 'string' ||
      !('category' in entry) ||
      typeof entry.category !== 'string' ||
      !categories.includes(entry.category)
    ) {
      throw new Error('invalid manifest item')
    }
  }
  // The checked fields establish the repository-owned legacy shape; deeper values are consumed by
  // the same TypeScript contract that produced this checked-in file.
  return { version, updatedAt, categories, items: items as LegacyItem[] }
}

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const manifestPath = resolve(
  process.cwd(),
  process.argv[2] ?? '../web/public/inspiration-manifest.json',
)
const raw = await Bun.file(manifestPath).text()
const manifest = parseManifest(raw)
const publishedAt = new Date(manifest.updatedAt).getTime()
if (!Number.isFinite(publishedAt)) throw new Error('manifest.updatedAt must be an ISO timestamp')

await runMigrations(databaseUrl)
try {
  const inserted = await db.transaction(async (tx) => {
    await tx
      .insert(schema.inspiration_categories)
      .values(
        manifest.categories.map((name, sort) => ({
          id: categoryId(name),
          name,
          sort,
          created_at: publishedAt,
          updated_at: publishedAt,
        })),
      )
      .onConflictDoNothing()

    const created = await tx
      .insert(schema.inspiration_items)
      .values(
        manifest.items.map((item, sort) => ({
          id: item.id,
          kind: 'showcase' as const,
          status: 'published' as const,
          featured: FEATURED_IDS[item.id] === true,
          title: item.title,
          description: item.description ?? null,
          category_id: categoryId(item.category),
          prompt: item.prompt,
          recommended_provider: item.recommendedProvider,
          recommended_model: item.recommendedModel,
          params: item.params,
          tags: item.tags ?? [],
          cover_key: item.thumbnailUrl,
          image_key: item.imageUrl ?? null,
          reference_images: [],
          skill_name: null,
          source_url: item.sourceUrl ?? null,
          author: item.author ?? null,
          sort,
          created_at: publishedAt,
          updated_at: publishedAt,
          updated_by: 'manifest-import',
          published_at: publishedAt,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: schema.inspiration_items.id })

    if (created.length) {
      await refreshPublication(tx)
      await tx.insert(schema.operator_audits).values({
        id: crypto.randomUUID(),
        operator_id: 'manifest-import',
        action: 'inspiration.import',
        target_type: 'inspiration',
        target_id: 'legacy-manifest',
        details: { inserted: created.length, sourceVersion: manifest.version },
        created_at: Date.now(),
      })
    }
    return created.length
  })
  console.log(`Inspiration import complete: inserted ${inserted}, source ${manifest.items.length}`)
} finally {
  await close()
}
