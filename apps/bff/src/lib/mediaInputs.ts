import { and, eq, inArray, isNotNull, like } from 'drizzle-orm'
import sharp from 'sharp'
import { config } from '../config'
import { db, schema } from '../db/client'
import { durableMediaStore } from './durableMediaStore'

/** 提交里按云媒体身份给的输入图：`aip-media:<media_objects.id>`。 */
export const MEDIA_INPUT_PATTERN = '^aip-media:[0-9a-f-]{36}$'
const MEDIA_INPUT = /^aip-media:([0-9a-f-]{36})$/i

// 与前端 `compressInputImage` 同一口径：长边 2048，小于 256KB 且上游认得的格式原样放行。
const MAX_EDGE = 2048
const PASSTHROUGH_BYTES = 256 * 1024
const UPSTREAM_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const LOAD_CONCURRENCY = 3

export class MediaInputError extends Error {}

function dataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
}

async function compressed(bytes: Uint8Array, contentType: string): Promise<string> {
  const upstream = UPSTREAM_TYPES.has(contentType)
  if (upstream && bytes.length <= PASSTHROUGH_BYTES) return dataUrl(bytes, contentType)
  try {
    const image = sharp(bytes, { failOn: 'warning' }).rotate()
    const metadata = await image.metadata()
    const resized = image.resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    const alpha = contentType !== 'image/jpeg' && Boolean(metadata.hasAlpha)
    const output = alpha
      ? await resized.png().toBuffer()
      : await resized.jpeg({ quality: 85 }).toBuffer()
    if (!upstream || output.length < bytes.length)
      return dataUrl(output, alpha ? 'image/png' : 'image/jpeg')
  } catch {
    if (!upstream) throw new MediaInputError('输入图片无法解码')
  }
  return dataUrl(bytes, contentType)
}

/**
 * 把按媒体身份给的输入图在服务端换成 data URL，后面的归档、计价、上游调用一概不变。
 * 字节从对象存储直接读，不再经浏览器下载一遍再整份 base64 传上来。媒体必须属于这个用户、
 * 已就绪且是图片。带遮罩时不缩放：原生遮罩要求与主图同尺寸。
 */
export async function resolveMediaInputs(
  userId: string | null,
  inputs: readonly string[] | undefined,
  options: { readonly masked: boolean },
): Promise<string[] | undefined> {
  if (!inputs?.some((input) => MEDIA_INPUT.test(input))) return inputs ? [...inputs] : inputs
  if (!userId) throw new MediaInputError('按媒体引用输入图需要登录')
  const ids = [
    ...new Set(inputs.flatMap((input) => MEDIA_INPUT.exec(input)?.[1]?.toLowerCase() ?? [])),
  ]
  const rows = await db
    .select({
      id: schema.media_objects.id,
      key: schema.media_objects.object_key,
      contentType: schema.media_objects.content_type,
      bytes: schema.media_objects.bytes,
    })
    .from(schema.media_objects)
    .where(
      and(
        inArray(schema.media_objects.id, ids),
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.status, 'ready'),
        isNotNull(schema.media_objects.object_key),
        like(schema.media_objects.content_type, 'image/%'),
      ),
    )
  const found = new Map(rows.map((row) => [row.id.toLowerCase(), row]))
  const resolved = new Map<string, Promise<string>>()
  const load = (id: string) => {
    const row = found.get(id)
    if (!row?.key) throw new MediaInputError('输入图片不存在或无权访问')
    if (row.bytes > config.operator.quotas['sync:asset-image-bytes'])
      throw new MediaInputError('输入图片过大')
    const key = row.key
    return durableMediaStore()
      .read(key)
      .then((bytes) =>
        options.masked ? exact(bytes, row.contentType) : compressed(bytes, row.contentType),
      )
  }
  // 先确权，再按固定并发读取：16 张大图同时解码会占满内存，逐张串行又把延迟叠起来。
  for (const id of ids)
    if (!found.get(id)?.key) throw new MediaInputError('输入图片不存在或无权访问')
  const queue = [...ids]
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const pending = load(id)
      resolved.set(id, pending)
      await pending
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, ids.length) }, worker))
  return Promise.all(
    inputs.map((input) => {
      const id = MEDIA_INPUT.exec(input)?.[1]?.toLowerCase()
      return id ? resolved.get(id)! : input
    }),
  )
}

/** 带遮罩：尺寸不能动；上游不认的格式按原尺寸转 PNG（保留 alpha）。 */
async function exact(bytes: Uint8Array, contentType: string): Promise<string> {
  if (UPSTREAM_TYPES.has(contentType)) return dataUrl(bytes, contentType)
  try {
    return dataUrl(await sharp(bytes, { failOn: 'warning' }).png().toBuffer(), 'image/png')
  } catch {
    throw new MediaInputError('输入图片无法解码')
  }
}
