import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { PersistedSubmitRequest } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.DATABASE_URL = await resetTestDatabase('bff_generation_media_known_bytes')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../project-media-operator-config.json')
const { db, schema, close } = await import('../../db/client')
const { config } = await import('../../config')
config.operator = {
  ...config.operator,
  quotas: { ...config.operator.quotas, 'sync:user-media-bytes': 64 * 1024 * 1024 },
}
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { storeMedia } = await import('../../lib/projectMedia')
const { hydrateInputImages } = await import('../../lib/imageArchive')
const { archiveGenerationOutputs, KnownMediaBytes, spoolGenerationOutputs } = await import(
  '../../lib/generationMedia'
)

class MediaStorage extends InMemoryObjectStore {
  sign(key: string, method: 'GET' | 'PUT', _contentType?: string) {
    return `https://storage.example.test/${key}?method=${method}`
  }
}
const USER = 'known-bytes-owner'
let storage: MediaStorage
beforeEach(async () => {
  await db.delete(schema.users)
  storage = new MediaStorage()
  setDurableMediaStoreForTesting(storage)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER,
    username: USER,
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
})
afterAll(close)

const png = (background: string) =>
  sharp({ create: { width: 4, height: 4, channels: 4, background } })
    .png()
    .toBuffer()
    .then((buffer) => new Uint8Array(buffer))
// 发布后对服务端 key（objects/…）的核对不算读回原件。
const reads = () =>
  storage.events.filter(
    (event) => /^(open|read|stream):/.test(event) && !event.includes(':objects/'),
  )

it('服务端自己的原件直接确认：不写暂存区、不读回，照旧发布原件与预览', async () => {
  const bytes = await png('#123456')
  const media = await storeMedia(USER, bytes, 'image/png')

  expect(media.status).toBe('ready')
  expect(storage.events.some((event) => event.includes('staging/'))).toBe(false)
  expect(reads()).toEqual([])
  const [row] = await db
    .select()
    .from(schema.media_objects)
    .where(eq(schema.media_objects.id, media.id))
  expect(row?.status).toBe('ready')
  // 原件之外还写了预览，都在服务端 key 下。
  expect(storage.events.filter((event) => event.startsWith('write:')).length).toBe(2)

  // 同一张再入库直接复用已发布的那份。
  const events = storage.events.length
  expect((await storeMedia(USER, bytes, 'image/png')).id).toBe(media.id)
  expect(storage.events.slice(events).some((event) => event.startsWith('write:'))).toBe(false)
})

it('生成结果与输入用手里的字节入库，不回存储读；结果、输入两张并行且按原顺序交回', async () => {
  const id = 'task-known-bytes'
  const output = await png('#ff0000')
  const input = await png('#00ff00')
  const unknown = await png('#0000ff')
  await storage.write(`${id}/in/0`, input, 'image/png')
  await storage.write(`${id}/in/1`, unknown, 'image/png')
  const request = {
    prompt: 'edit',
    input_images: [
      { object: `${id}/in/0`, mime: 'image/png', store: 'durable' },
      { object: `${id}/in/1`, mime: 'image/png', store: 'durable' },
    ],
  } as unknown as PersistedSubmitRequest
  const known = new KnownMediaBytes()
  // 只有第一张输入是这次执行从存储读来送上游的。
  known.rememberRead(
    { object: `${id}/in/0`, store: 'durable' },
    `data:image/png;base64,${Buffer.from(input).toString('base64')}`,
  )
  const payload = await spoolGenerationOutputs(
    id,
    'openai-compat',
    { data: [{ b64_json: Buffer.from(output).toString('base64') }] },
    undefined,
    new AbortController().signal,
    known,
  )

  storage.events.length = 0
  let active = 0
  let peak = 0
  const write = storage.write.bind(storage)
  storage.write = async (...args: Parameters<typeof write>) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    try {
      return await write(...args)
    } finally {
      active--
    }
  }
  const links = await archiveGenerationOutputs(
    USER,
    'openai-compat',
    payload,
    request,
    undefined,
    known,
  )

  expect(links.map(({ role, position }) => `${role}:${position}`)).toEqual([
    'output:0',
    'input:0',
    'input:1',
  ])
  // 只有没记下的那张输入回存储读了一次；结果与第一张输入都没再读。
  expect(reads()).toEqual([`open:${id}/in/1`, `stream:${id}/in/1:0-${unknown.length - 1}`])
  expect(storage.events.some((event) => event.includes('staging/'))).toBe(false)
  expect(peak).toBeGreaterThan(1)
  const rows = await db
    .select()
    .from(schema.media_objects)
    .where(eq(schema.media_objects.user_id, USER))
  expect(rows.map((row) => row.status)).toEqual(['ready', 'ready', 'ready'])
  // 入库成功就放掉手里的字节。
  expect(known.get('durable', `${id}/out/0`)).toBeUndefined()
  expect(known.get('durable', `${id}/in/0`)).toBeUndefined()
})

it('只记 hydrateInputImages 按引用从存储读出的原件，原样传入的 data URL 不记', async () => {
  const id = 'task-known-hydrate'
  const input = await png('#123456')
  await storage.write(`${id}/in/0`, input, 'image/png')
  const known = new KnownMediaBytes()
  const passthrough = `data:image/png;base64,${Buffer.from(await png('#654321')).toString('base64')}`
  await hydrateInputImages(
    {
      prompt: 'edit',
      input_images: [{ object: `${id}/in/0`, mime: 'image/png', store: 'durable' }, passthrough],
    } as unknown as PersistedSubmitRequest,
    { onObjectRead: known.rememberRead },
  )
  expect(Buffer.from(known.get('durable', `${id}/in/0`)!).equals(Buffer.from(input))).toBe(true)
  expect(known.get('object', passthrough)).toBeUndefined()
})

it('一张入库失败时等另一张跑完再报错', async () => {
  const id = 'task-known-bytes-failure'
  const good = await png('#abcdef')
  const request = {
    prompt: 'edit',
    input_images: [{ object: `${id}/in/0`, mime: 'image/png', store: 'durable' }],
  } as unknown as PersistedSubmitRequest
  await storage.write(`${id}/in/0`, new TextEncoder().encode('not an image'), 'image/png')
  const payload = await spoolGenerationOutputs(
    id,
    'openai-compat',
    { data: [{ b64_json: Buffer.from(good).toString('base64') }] },
    undefined,
    new AbortController().signal,
  )

  await expect(
    archiveGenerationOutputs(USER, 'openai-compat', payload, request),
  ).rejects.toBeDefined()
  // 坏的那张失败时，好的那张已发布完毕，没被半途丢下。
  const rows = await db
    .select()
    .from(schema.media_objects)
    .where(eq(schema.media_objects.user_id, USER))
  expect(rows.filter((row) => row.status === 'ready').length).toBe(1)
})

it('贴着配额上限时两张并行预留被误拒的那张，等同伴发布后串行补一次', async () => {
  const id = 'task-known-quota'
  const output = await png('#a0a0a0')
  const input = await png('#0a0a0a')
  await storage.write(`${id}/in/0`, input, 'image/png')
  const request = {
    prompt: 'edit',
    input_images: [{ object: `${id}/in/0`, mime: 'image/png', store: 'durable' }],
  } as unknown as PersistedSubmitRequest
  const payload = await spoolGenerationOutputs(
    id,
    'openai-compat',
    { data: [{ b64_json: Buffer.from(output).toString('base64') }] },
    undefined,
    new AbortController().signal,
  )
  const previous = config.operator
  // 两条预留同时各占 512 KiB 预览预算放不下；一张发布后预算收回到实际预览大小，第二张就放得下。
  config.operator = {
    ...previous,
    quotas: {
      ...previous.quotas,
      'sync:user-media-bytes': output.length + input.length + 512 * 1024 + 64 * 1024,
    },
  }
  try {
    const links = await archiveGenerationOutputs(USER, 'openai-compat', payload, request)
    expect(links.map(({ role }) => role)).toEqual(['output', 'input'])
  } finally {
    config.operator = previous
  }
  const rows = await db
    .select()
    .from(schema.media_objects)
    .where(eq(schema.media_objects.user_id, USER))
  expect(rows.map((row) => row.status)).toEqual(['ready', 'ready'])
})
