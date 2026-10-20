/**
 * Point inspiration items' cover/image at absolute URLs through updateInspirationItem
 * (the same path as the admin PUT /internal/admin/inspirations/:id). publicAssetUrl() passes
 * absolute http(s) keys through unchanged.
 *
 *   bun run scripts/inspiration-repoint.ts <map.json> [--apply] [--operator <id>]
 * map.json: { "<id>": { "cover": "<url>?w=320&q=85", "image": "<url>" }, ... }
 * (mirrors the old cms-r2 rows: cover = thumbnail URL with resize query, image = full URL)
 */
import { resolve } from 'node:path'
import { close } from '../src/db/client'
import { getInspirationItem, updateInspirationItem } from '../src/lib/inspirations'

const args = process.argv.slice(2)
const oi = args.indexOf('--operator')
const operatorId = oi >= 0 ? (args[oi + 1] ?? '') : 'inspiration-repoint-script'
const file = args.find((a, i) => !a.startsWith('--') && (oi < 0 || i !== oi + 1))
if (!file) throw new Error('usage: inspiration-repoint.ts <map.json> [--apply] [--operator <id>]')
const apply = args.includes('--apply')
const map = JSON.parse(await Bun.file(resolve(process.cwd(), file)).text()) as Record<
  string,
  { cover: string; image: string }
>
try {
  const problems: string[] = []
  const rows = []
  for (const [id, url] of Object.entries(map)) {
    if (!/^https:\/\//.test(url.cover) || !/^https:\/\//.test(url.image))
      problems.push(`${id}: not an https url`)
    const item = await getInspirationItem(id)
    if (!item) {
      problems.push(`${id}: missing`)
      continue
    }
    rows.push({ item, url })
  }
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${rows.length} items, ${problems.length} problems`)
  for (const { item, url } of rows)
    console.log(`  ${item.id}\t${item.status}\t${item.coverKey} -> ${url.cover} | ${url.image}`)
  for (const p of problems) console.log(`  ! ${p}`)
  if (problems.length) process.exitCode = 1
  else if (apply) {
    for (const { item, url } of rows) {
      await updateInspirationItem(
        item.id,
        {
          id: item.id,
          kind: item.kind,
          featured: item.featured,
          title: item.title,
          description: item.description,
          categoryId: item.categoryId,
          prompt: item.prompt,
          recommendedProvider: item.recommendedProvider,
          recommendedModel: item.recommendedModel,
          params: item.params,
          tags: item.tags,
          coverKey: url.cover,
          imageKey: url.image,
          referenceImages: item.referenceImages,
          skillName: item.skillName,
          sourceUrl: item.sourceUrl,
          author: item.author,
          sort: item.sort,
        } as Parameters<typeof updateInspirationItem>[1],
        operatorId,
      )
      console.log(`updated ${item.id}`)
    }
  }
} finally {
  await close()
}
