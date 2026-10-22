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
const { abortRunningTask } = await import('../../workers/task-execution')
const { maskedEditSettings } = await import('../../lib/agent/masked-edit-settings')
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
    error_type: 'upstream_error',
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

it('cloud archive terminates an incompatible masked candidate without repeating generation', async () => {
  const id = crypto.randomUUID()
  const candidate = await sharp({
    create: { width: 1, height: 1, channels: 4, background: 'blue' },
  })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting((async () => {
    calls++
    return Response.json({ data: [{ b64_json: candidate.toString('base64') }] })
  }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  await submit(id, true)
  await runTask(id)
  expect(await task(id)).toMatchObject({ status: 'failed', error_type: 'upstream_error' })
  expect((await task(id)).error_message).toContain('尺寸与原图不一致')
  expect(await durable.read(`${id}/candidate/0`)).toEqual(new Uint8Array(candidate))
  await runTask(id)
  expect(calls).toBe(1)
})

for (const retries of [0, 1])
  it(
    retries
      ? 'asks again only for the selected region the first generation left untouched, when retries are on'
      : 'by default only checks the regions: one upstream call, an untouched region stays as it was',
    async () => {
      const regionSettings = maskedEditSettings.regions as { maxRetries: number }
      const configured = regionSettings.maxRetries
      regionSettings.maxRetries = retries
      const id = `regions-${retries}`
      try {
        const size = 256
        const inA = (x: number, y: number) => x >= 40 && x < 80 && y >= 40 && y < 80
        const inB = (x: number, y: number) => x >= 170 && x < 210 && y >= 170 && y < 210
        const base = Buffer.alloc(size * size * 4),
          selection = Buffer.alloc(base.length, 255)
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4
            base.set(
              [
                128 + 80 * Math.sin(x / 9),
                128 + 80 * Math.cos(y / 11),
                128 + 70 * Math.sin((x + y) / 7),
                255,
              ],
              i,
            )
            if (inA(x, y) || inB(x, y)) selection[i + 3] = 0
          }
        const encode = (data: Buffer) =>
          sharp(data, { raw: { width: size, height: size, channels: 4 } })
            .png()
            .toBuffer()
        const paint = (inside: (x: number, y: number) => boolean) => {
          const copy = Buffer.from(base)
          for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++)
              if (inside(x, y)) copy.set([10, 10, 10], (y * size + x) * 4)
          return encode(copy)
        }
        const replies = [await paint(inA), await paint(inB)]
        const masks: Buffer[] = []
        setUpstreamFetchForTesting((async (_input: unknown, init?: RequestInit) => {
          const sent = (init?.body as FormData).get('mask') as Blob
          masks.push(Buffer.from(await sent.arrayBuffer()))
          const reply = replies[masks.length - 1]!
          return Response.json({ data: [{ b64_json: reply.toString('base64') }] })
        }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)

        const archived = await archiveInputImages(id, {
          prompt: 'paint both squares',
          input_images: [url(await encode(base))],
          mask: url(await encode(selection)),
        })
        await db.insert(schema.tasks).values({
          id,
          provider: 'openai-compat',
          model: 'test-model',
          status: 'queued',
          submitted_at: 1,
          request_payload: { ...archived, preserve_outside_mask: true },
        })
        await runTask(id)
        expect(await task(id)).toMatchObject({
          status: 'completed',
          upstream_invocation_count: 1 + retries,
        })
        expect(masks).toHaveLength(1 + retries)
        const delivered = await sharp(await store.read(`${id}/out/0`))
          .raw()
          .toBuffer()
        const at = (x: number, y: number) => [
          ...delivered.subarray((y * size + x) * 4, (y * size + x) * 4 + 3),
        ]
        for (let i = 0; i < base.length; i += 4)
          if (
            selection[i + 3] === 255 &&
            !base.subarray(i, i + 4).equals(delivered.subarray(i, i + 4))
          )
            throw new Error('changed protected pixel')
        expect(at(60, 60)).toEqual([10, 10, 10])
        if (!retries) {
          // 没有重试：B 照原样留着（只记进检查结果），不多花一次上游调用。
          expect(at(190, 190)).toEqual([
            ...base.subarray((190 * size + 190) * 4, (190 * size + 190) * 4 + 3),
          ])
          return
        }
        const retryMask = await sharp(masks[1]!).ensureAlpha().raw().toBuffer()
        for (const [x, y, edited] of [
          [60, 60, false],
          [190, 190, true],
          [5, 5, false],
        ] as const)
          expect(retryMask[(y * size + x) * 4 + 3] === 0).toBe(edited)
        expect(at(190, 190)).toEqual([10, 10, 10])
      } finally {
        regionSettings.maxRetries = configured
      }
    },
  )
