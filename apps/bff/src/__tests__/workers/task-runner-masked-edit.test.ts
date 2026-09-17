import { afterAll, afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { forbidGlobalFetch, upstreamReturning } from '../helpers/upstreamStubs'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = await resetTestDatabase('bff_task_runner_masked_edit')
process.env.PORT = '0'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../projects-operator-config.json')
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
const { close, db, schema } = await import('../../db/client')
const { runTask } = await import('../../workers/task-runner')
const { archiveInputImages, hydrateInputImages } = await import('../../lib/imageArchive')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { abortRunningTask } = await import('../../workers/task-runner')
class DurableFixture extends InMemoryObjectStore {
  stopAfterCandidate: string | null = null
  sign(key: string) {
    return `https://durable.example/${key}`
  }
  override async write(key: string, bytes: Uint8Array, contentType: string) {
    await super.write(key, bytes, contentType)
    if (this.stopAfterCandidate && key === `${this.stopAfterCandidate}/candidate/0`) {
      abortRunningTask(this.stopAfterCandidate)
      throw new DOMException('Worker stopped after candidate', 'AbortError')
    }
  }
}
let durable: DurableFixture
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
let store: InMemoryObjectStore
let restoreFetch: () => void

beforeEach(async () => {
  durable = new DurableFixture()
  setDurableMediaStoreForTesting(durable)
  store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
  restoreFetch = forbidGlobalFetch()
  await db.delete(schema.tasks)
  await db.delete(schema.users)
  await db.insert(schema.users).values({
    id: 'owner',
    username: 'owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: 1,
    updated_at: 1,
  })
})
afterEach(() => {
  setUpstreamFetchForTesting()
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
  restoreFetch()
})
afterAll(close)

async function png(values: number[], mask = false) {
  const raw = Buffer.alloc(96 * 96 * 4)
  for (let i = 0; i < raw.length; i += 4)
    raw.set(mask ? [0, 0, 0, 255] : [i % 251, (i * 7) % 253, (i * 3) % 249, 255], i)
  raw.set(values)
  return sharp(raw, { raw: { width: 96, height: 96, channels: 4 } })
    .png()
    .toBuffer()
}
const source = await png([255, 0, 0, 255, 0, 255, 0, 255])
const mask = await png([0, 0, 0, 0, 0, 0, 0, 255], true)
const url = (value: Buffer) => `data:image/png;base64,${value.toString('base64')}`
async function submit(id: string, cloud = false) {
  const archived = await archiveInputImages(id, {
    prompt: 'change selected object',
    input_images: [url(source)],
    mask: url(mask),
  })
  await db.insert(schema.tasks).values({
    id,
    user_id: cloud ? 'owner' : undefined,
    provider: 'openai-compat',
    model: 'test-model',
    status: 'queued',
    submitted_at: 1,
    request_payload: { ...archived, preserve_outside_mask: true },
  })
  expect(await hydrateInputImages({ ...archived, preserve_outside_mask: true })).not.toHaveProperty(
    'preserve_outside_mask',
  )
}
async function task(id: string) {
  return (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
}

it('archives the untouched candidate but delivers only the protected result', async () => {
  const candidate = await png([0, 0, 255, 255, 0, 0, 255, 255])
  setUpstreamFetchForTesting(
    upstreamReturning({
      data: [{ b64_json: candidate.toString('base64') }],
      output_format: 'jpeg',
    }),
  )
  await submit('protected')
  await runTask('protected')
  expect((await task('protected')).status).toBe('completed')
  expect(Buffer.from(await store.read('protected/candidate/0')).equals(candidate)).toBe(true)
  expect([
    ...(
      await sharp(await store.read('protected/out/0'))
        .raw()
        .toBuffer()
    ).subarray(0, 8),
  ]).toEqual([0, 0, 255, 255, 0, 255, 0, 255])
  expect((await task('protected')).result_payload).toMatchObject({ output_format: 'png' })
  expect((await task('protected')).result_payload).toMatchObject({
    size: '96x96',
    data: [{ size: '96x96', width: 96, height: 96 }],
  })
})

it('retains an incompatible candidate and fails without a second generation', async () => {
  const candidate = await sharp({
    create: { width: 1, height: 1, channels: 4, background: 'blue' },
  })
    .png()
    .toBuffer()
  setUpstreamFetchForTesting(
    upstreamReturning({
      data: [{ b64_json: candidate.toString('base64') }, { b64_json: source.toString('base64') }],
    }),
  )
  await submit('mismatch')
  await runTask('mismatch')
  expect(await task('mismatch')).toMatchObject({
    status: 'failed',
    attempt_count: 0,
    upstream_invocation_count: 1,
  })
  expect((await task('mismatch')).error_message).toContain('尺寸与原图不一致')
  expect(store.objects.has('mismatch/candidate/0')).toBe(true)
  expect(store.objects.has('mismatch/candidate/1')).toBe(true)
  expect((await task('mismatch')).result_payload).toMatchObject({
    masked_edit_candidates: [
      { object: 'mismatch/candidate/0', mime: 'image/png' },
      { object: 'mismatch/candidate/1', mime: 'image/png' },
    ],
  })
  expect(store.objects.has('mismatch/out/0')).toBe(false)
})

it('does not automatically generate again when a masked edit returns no candidate', async () => {
  setUpstreamFetchForTesting(upstreamReturning({ data: [] }))
  await submit('empty')
  await runTask('empty')
  expect(await task('empty')).toMatchObject({
    status: 'failed',
    attempt_count: 0,
    upstream_invocation_count: 1,
  })
})

it('cloud archive resumes a saved masked candidate and keeps protected pixels unchanged', async () => {
  const id = crypto.randomUUID()
  const candidate = await png([0, 0, 255, 255, 0, 0, 255, 255])
  let calls = 0
  setUpstreamFetchForTesting((async () => {
    calls++
    return Response.json({ data: [{ b64_json: candidate.toString('base64') }] })
  }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  await submit(id, true)
  durable.stopAfterCandidate = id
  await runTask(id)
  durable.stopAfterCandidate = null
  const { recoverTasksByIds } = await import('../../db/maintenance')
  await recoverTasksByIds([id])
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 61000)
  try {
    await runTask(id)
  } finally {
    clock.mockRestore()
  }
  expect((await task(id)).status).toBe('completed')
  expect([
    ...(
      await sharp(await durable.read(`${id}/out/0`))
        .raw()
        .toBuffer()
    ).subarray(0, 8),
  ]).toEqual([0, 0, 255, 255, 0, 255, 0, 255])
  expect(calls).toBe(1)
})
