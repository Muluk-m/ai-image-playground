/**
 * Add showcase inspirations from a local folder through the same path the admin UI uses:
 * presigned upload to the public asset bucket, create as draft, then (with --publish) publish.
 *
 *   bun run scripts/inspiration-add.ts <dir> [--apply] [--publish] [--operator <id>]
 *
 * <dir>/items.json is an array of
 *   { id, title, prompt, category, size, file, featured?, sort?, tags?, description? }
 * where `category` is an existing category name and `file` is relative to <dir>.
 * Without --apply it only validates and prints. The whole manifest is validated (shape, required
 * fields, duplicate ids, files (symlinks resolved, must stay inside <dir>), categories, existing rows and, with --publish, the publish checks
 * including the model) before the first upload, so a bad entry cannot leave a half-written batch.
 *
 * Existing ids: a draft this script created earlier with the same metadata is resumed
 * (published with --publish); a published one with the same content is skipped. Any other
 * existing row (different content, an archived item, or a draft someone else wrote) is reported
 * as a conflict and stops the run: archived items come back only through an explicit
 * `inspiration-status.ts --restore`, never as a side effect of an import.
 * Undo: archive the ids with scripts/inspiration-status.ts (published items must be archived
 * before the admin UI can delete them).
 */
import { closeSync, constants, openSync, readFileSync, realpathSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import type { InspirationAdminItem, InspirationWriteInput } from '@image-playground/shared'
import { config } from '../src/config'
import { close } from '../src/db/client'
import { initChannels } from '../src/lib/channels'
import {
  createInspirationItem,
  getInspirationItem,
  InspirationOperationError,
  listInspirationCategories,
  setInspirationStatus,
  validateForPublish,
  validateWriteInput,
} from '../src/lib/inspirations'
import { createInspirationUploadTarget } from '../src/lib/public-assets'
import { parseArgs } from './inspiration-cli'

interface NewItem {
  id: string
  title: string
  prompt: string
  category: string
  size: string
  file: string
  featured: boolean
  sort: number
  tags: string[]
  description: string | null
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
const MODEL = { provider: 'openai-compat', model: 'gpt-image-2.5-flare' }
const AUTHOR = 'Muvloom'
const PARAMS = (item: { size: string }) => ({ size: item.size, quality: 'high' as const, n: 1 })

const USAGE = 'inspiration-add.ts <dir> [--apply] [--publish] [--operator <id>]'
const {
  file: dir,
  flags,
  options,
} = parseArgs(process.argv.slice(2), {
  flags: ['--apply', '--publish'],
  options: ['--operator'],
  usage: USAGE,
})
const apply = flags.has('--apply')
const publish = flags.has('--publish')
const operatorId = options.get('--operator') ?? 'inspiration-add-script'
const root = resolve(process.cwd(), dir)

const problems: string[] = []
const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/** Runtime shape check of items.json; never trust the type assertion alone. */
function parseItems(raw: unknown): NewItem[] {
  if (!Array.isArray(raw)) {
    problems.push('items.json must be a JSON array')
    return []
  }
  const items: NewItem[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const at = `#${index}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${at}: not an object`)
      return
    }
    const value = entry as Record<string, unknown>
    const label = nonEmpty(value.id) ? value.id.trim() : at
    const before = problems.length
    for (const field of ['id', 'title', 'prompt', 'category', 'size', 'file'] as const) {
      if (!nonEmpty(value[field])) problems.push(`${label}: ${field} must be a non-empty string`)
    }
    if (value.featured !== undefined && typeof value.featured !== 'boolean')
      problems.push(`${label}: featured must be a boolean`)
    if (value.sort !== undefined && !Number.isInteger(value.sort))
      problems.push(`${label}: sort must be an integer`)
    if (
      value.tags !== undefined &&
      !(Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string'))
    )
      problems.push(`${label}: tags must be a string array`)
    if (value.description !== undefined && typeof value.description !== 'string')
      problems.push(`${label}: description must be a string`)
    if (problems.length > before) return
    const id = (value.id as string).trim()
    if (seen.has(id)) {
      problems.push(`${id}: duplicate id`)
      return
    }
    seen.add(id)
    items.push({
      id,
      title: (value.title as string).trim(),
      prompt: (value.prompt as string).trim(),
      category: (value.category as string).trim(),
      size: (value.size as string).trim(),
      file: (value.file as string).trim(),
      featured: value.featured === true,
      sort: (value.sort as number | undefined) ?? 0,
      tags: ((value.tags as string[] | undefined) ?? []).map((tag) => tag.trim()).filter(Boolean),
      description: (value.description as string | undefined)?.trim() || null,
    })
  })
  return items
}

const writeInput = (item: NewItem, categoryId: string, key: string): InspirationWriteInput => ({
  id: item.id,
  kind: 'showcase',
  featured: item.featured,
  title: item.title,
  description: item.description,
  categoryId,
  prompt: item.prompt,
  recommendedProvider: MODEL.provider,
  recommendedModel: MODEL.model,
  params: PARAMS(item),
  tags: item.tags,
  coverKey: key,
  imageKey: key,
  referenceImages: [],
  skillName: null,
  sourceUrl: null,
  author: AUTHOR,
  sort: item.sort,
})

/** Key-order-independent JSON (jsonb does not keep key order). */
const canonical = (value: object) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))

/**
 * Every metadata field this script writes must match for an existing row to count as the same
 * import. The image itself is not compared (the stored key is random); to replace an image use a
 * new id or the admin UI.
 */
const sameContent = (existing: InspirationAdminItem, item: NewItem, categoryId: string) =>
  existing.kind === 'showcase' &&
  existing.title === item.title &&
  existing.prompt === item.prompt &&
  existing.categoryId === categoryId &&
  existing.featured === item.featured &&
  existing.sort === item.sort &&
  (existing.description ?? null) === item.description &&
  JSON.stringify(existing.tags) === JSON.stringify(item.tags) &&
  canonical(existing.params) === canonical(PARAMS(item)) &&
  existing.coverKey === existing.imageKey &&
  existing.referenceImages.length === 0 &&
  existing.skillName === null &&
  existing.sourceUrl === null &&
  existing.author === AUTHOR &&
  existing.recommendedProvider === MODEL.provider &&
  existing.recommendedModel === MODEL.model

/**
 * Read a validated file without a check-then-use race: open it, then confirm through the open
 * descriptor itself (whatever symlinks led there) that it is still inside root before reading.
 */
function readInside(rootReal: string, path: string): Blob {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    const opened = realpathSync(`/proc/self/fd/${fd}`)
    if (!opened.startsWith(rootReal + sep)) throw new Error(`${path}: moved outside ${rootReal}`)
    return new Blob([readFileSync(fd)])
  } finally {
    closeSync(fd)
  }
}

/** Real path of a manifest file if it stays inside root after resolving symlinks, else null. */
function fileInside(rootReal: string, relative: string): string | null | 'missing' {
  let real: string
  try {
    real = realpathSync(resolve(rootReal, relative))
  } catch {
    return 'missing'
  }
  return real.startsWith(rootReal + sep) ? real : null
}

/** What --apply will do with each item; anything unsafe becomes a problem. */
type Action = 'create' | 'resume' | 'skip'

try {
  const items = parseItems(JSON.parse(await Bun.file(`${root}/items.json`).text()))
  const categories = new Map((await listInspirationCategories()).map((c) => [c.name, c.id]))
  if (publish) {
    // Publishing checks the recommended model against the loaded channels, as the BFF does.
    const channels = initChannels(config.channelsFile ?? undefined)
    for (const warning of channels.warnings) console.log(`  ! channels: ${warning}`)
  }
  const actions = new Map<string, Action>()
  const files = new Map<string, string>()
  const rootReal = realpathSync(root)
  for (const item of items) {
    const path = fileInside(rootReal, item.file)
    if (path === 'missing') problems.push(`${item.id}: missing file`)
    else if (path === null) problems.push(`${item.id}: file escapes ${dir} (symlinks resolved)`)
    else if (!CONTENT_TYPES[extname(path).toLowerCase()])
      problems.push(`${item.id}: unsupported file`)
    else files.set(item.id, path)
    if (!files.has(item.id)) continue
    const categoryId = categories.get(item.category)
    if (!categoryId) {
      problems.push(`${item.id}: unknown category ${item.category}`)
      continue
    }
    try {
      const input = writeInput(item, categoryId, 'pending-upload')
      if (publish) await validateForPublish(input)
      else validateWriteInput(input)
    } catch (error) {
      if (!(error instanceof InspirationOperationError)) throw error
      problems.push(`${item.id}: ${error.code}`)
      continue
    }
    const existing = await getInspirationItem(item.id)
    if (!existing) actions.set(item.id, 'create')
    else if (
      existing.status === 'draft' &&
      existing.updatedBy === operatorId &&
      sameContent(existing, item, categoryId)
    )
      actions.set(item.id, publish ? 'resume' : 'skip')
    else if (existing.status === 'published' && sameContent(existing, item, categoryId))
      actions.set(item.id, 'skip')
    else
      problems.push(
        `${item.id}: conflicts with existing ${existing.status} item "${existing.title}" ` +
          `(updated by ${existing.updatedBy ?? 'unknown'})`,
      )
  }
  const needsUpload = [...actions.values()].includes('create')
  if (needsUpload && (!config.publicAssets.bucket || !config.publicAssets.baseUrl)) {
    problems.push(
      'PUBLIC_ASSET_BUCKET / PUBLIC_ASSET_BASE_URL are not configured: uploads are unavailable',
    )
  }
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${items.length} items, ${problems.length} problems`)
  for (const item of items) {
    console.log(
      `  ${item.id}\t${actions.get(item.id) ?? '-'}\t${item.category}\t` +
        `${item.featured ? '★ ' : ''}${item.title}\tsort=${item.sort}`,
    )
  }
  for (const problem of problems) console.log(`  ! ${problem}`)
  if (problems.length) process.exitCode = 1
  else if (!apply)
    console.log('Nothing written. Re-run with --apply (and --publish) to upload and create.')
  else {
    for (const item of items) {
      const action = actions.get(item.id)
      if (action === 'create') {
        const path = files.get(item.id) as string
        const contentType = CONTENT_TYPES[extname(path).toLowerCase()] as string
        const body = readInside(rootReal, path)
        const target = createInspirationUploadTarget({ filename: item.file, contentType })
        const uploaded = await fetch(target.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': contentType },
          body,
        })
        if (!uploaded.ok) throw new Error(`${item.id}: upload failed ${uploaded.status}`)
        await createInspirationItem(
          writeInput(item, categories.get(item.category) as string, target.key),
          operatorId,
        )
        console.log(`created draft ${item.id} -> ${target.publicUrl}`)
      } else {
        console.log(`exists ${item.id}, upload skipped`)
      }
      if (publish && (action === 'create' || action === 'resume')) {
        await setInspirationStatus(item.id, 'published', operatorId)
        console.log(`published ${item.id}`)
      }
    }
  }
} finally {
  await close()
}
