/**
 * Add showcase inspirations from a local folder through the same path the admin UI uses:
 * presigned upload to the public asset bucket, create as draft, then (with --publish) publish.
 *
 *   bun run scripts/inspiration-add.ts <dir> [--apply] [--publish] [--operator <id>]
 *
 * <dir>/items.json is an array of
 *   { id, title, prompt, category, size, file, featured?, sort?, tags?, description? }
 * where `category` is an existing category name and `file` is relative to <dir>.
 * Without --apply it only validates and prints. Existing ids are skipped, so a re-run resumes.
 * Undo: archive the ids with scripts/inspiration-status.ts (published items must be archived
 * before the admin UI can delete them).
 */
import { extname, resolve } from 'node:path'
import { config } from '../src/config'
import { close } from '../src/db/client'
import { initChannels } from '../src/lib/channels'
import {
  createInspirationItem,
  getInspirationItem,
  listInspirationCategories,
  setInspirationStatus,
} from '../src/lib/inspirations'
import { createInspirationUploadTarget } from '../src/lib/public-assets'

interface NewItem {
  id: string
  title: string
  prompt: string
  category: string
  size: string
  file: string
  featured?: boolean
  sort?: number
  tags?: string[]
  description?: string
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
const MODEL = { provider: 'openai-compat', model: 'gpt-image-2.5-flare' }

const args = process.argv.slice(2)
const operatorIndex = args.indexOf('--operator')
const operatorId = operatorIndex >= 0 ? (args[operatorIndex + 1] ?? '') : 'inspiration-add-script'
const dir = args.find(
  (arg, index) => !arg.startsWith('--') && (operatorIndex < 0 || index !== operatorIndex + 1),
)
if (!dir) throw new Error('usage: inspiration-add.ts <dir> [--apply] [--publish] [--operator <id>]')
const apply = args.includes('--apply')
const publish = args.includes('--publish')
const root = resolve(process.cwd(), dir)
const items = JSON.parse(await Bun.file(`${root}/items.json`).text()) as NewItem[]

try {
  const categories = new Map((await listInspirationCategories()).map((c) => [c.name, c.id]))
  const problems: string[] = []
  for (const item of items) {
    if (!categories.has(item.category))
      problems.push(`${item.id}: unknown category ${item.category}`)
    if (!CONTENT_TYPES[extname(item.file).toLowerCase()])
      problems.push(`${item.id}: unsupported file`)
    if (!(await Bun.file(`${root}/${item.file}`).exists()))
      problems.push(`${item.id}: missing file`)
  }
  if (!config.publicAssets.bucket || !config.publicAssets.baseUrl) {
    problems.push(
      'PUBLIC_ASSET_BUCKET / PUBLIC_ASSET_BASE_URL are not configured: uploads are unavailable',
    )
  }
  // Publishing checks the recommended model against the loaded channels, as the BFF does.
  if (publish) initChannels(config.channelsFile ?? undefined)
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${items.length} items, ${problems.length} problems`)
  for (const item of items) {
    console.log(
      `  ${item.id}\t${item.category}\t${item.featured ? '★ ' : ''}${item.title}\tsort=${item.sort ?? 0}`,
    )
  }
  for (const problem of problems) console.log(`  ! ${problem}`)
  if (problems.length) process.exitCode = 1
  else if (!apply)
    console.log('Nothing written. Re-run with --apply (and --publish) to upload and create.')
  else {
    for (const item of items) {
      const existing = await getInspirationItem(item.id)
      if (!existing) {
        const contentType = CONTENT_TYPES[extname(item.file).toLowerCase()] as string
        const body = Bun.file(`${root}/${item.file}`)
        const target = createInspirationUploadTarget({ filename: item.file, contentType })
        const uploaded = await fetch(target.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': contentType },
          body,
        })
        if (!uploaded.ok) throw new Error(`${item.id}: upload failed ${uploaded.status}`)
        await createInspirationItem(
          {
            id: item.id,
            kind: 'showcase',
            featured: item.featured === true,
            title: item.title,
            description: item.description ?? null,
            categoryId: categories.get(item.category) as string,
            prompt: item.prompt,
            recommendedProvider: MODEL.provider,
            recommendedModel: MODEL.model,
            params: { size: item.size, quality: 'high', n: 1 },
            tags: item.tags ?? [],
            coverKey: target.key,
            imageKey: target.key,
            referenceImages: [],
            skillName: null,
            sourceUrl: null,
            author: 'Muvloom',
            sort: item.sort ?? 0,
          },
          operatorId,
        )
        console.log(`created draft ${item.id} -> ${target.publicUrl}`)
      } else {
        console.log(`exists ${item.id} (${existing.status}), upload skipped`)
      }
      if (publish && (existing?.status ?? 'draft') !== 'published') {
        await setInspirationStatus(item.id, 'published', operatorId)
        console.log(`published ${item.id}`)
      }
    }
  }
} finally {
  await close()
}
