import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'
import { TEST_IMAGE_CHANNEL } from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_looks_batch_credits')
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../looks-batch-billing-operator-config.json',
)

const billing = installRecordingTaskHooks()
const { _setPrivateBffOverlayForTesting, loadPrivateBffOverlay } = await import(
  '../../lib/private-overlay'
)
// 报价按张 1 分：积分不够时路由用它把整批的总价报出来。
const overlay = await loadPrivateBffOverlay()
_setPrivateBffOverlayForTesting({
  ...overlay,
  taskHooks: {
    ...overlay.taskHooks,
    async quoteTask({ quantity }) {
      return { estimatedCredits: quantity, pricing: {} as never }
    },
  },
})

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { lookRoutes } = await import('../../routes/looks')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { assetObjectKey } = await import('../../lib/sync-assets')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(lookRoutes)
const USER = 'look-batch-credits-owner'
const DEVICE = 'device-abcdefgh'
const MODEL = TEST_IMAGE_CHANNEL.models[0]!.id
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=',
  'base64',
)
const BODY = [
  '## 1. 一句话目标',
  '把产品放进极简棚拍场景。',
  '',
  '## 3. 需要用户提供的输入',
  '- 产品素材 ×1',
  '',
  '## 4. 工作流程',
  '1. 先看输入图。',
].join('\n')

let cookie = ''
let storage: InMemoryObjectStore

async function putAsset(id: string, imageId: string): Promise<void> {
  const now = Date.now()
  await db.insert(schema.user_assets).values({
    user_id: USER,
    id,
    name: id,
    image_id: imageId,
    kind: 'product',
    background: 'solid',
    views: [{ imageId, label: 'front', source: 'upload' }],
    created_at: now,
    updated_at: now,
    last_used_at: now,
    version: 1,
  })
  await db.insert(schema.user_asset_objects).values({
    user_id: USER,
    image_id: imageId,
    bytes: PNG.length,
    content_type: 'image/png',
    created_at: now,
  })
  await storage.write(assetObjectKey(USER, imageId), PNG, 'image/png')
}

async function putLook(id: string): Promise<void> {
  const now = Date.now()
  await db.insert(schema.user_looks).values({
    user_id: USER,
    id,
    name: '极简棚拍',
    description: '白底棚拍主图',
    purpose: 'hero',
    body: BODY,
    model: MODEL,
    size: '1024x1536',
    slot_count: 1,
    reference_image_ids: [],
    cover_image_id: null,
    created_at: now,
    updated_at: now,
    last_used_at: now,
    version: 1,
  })
}

async function batch(body: unknown) {
  const response = await app.handle(
    new Request('http://localhost/api/looks/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

afterAll(async () => {
  _setChannelsForTesting([])
  setObjectStoreForTesting()
  await closeDb()
})

beforeEach(async () => {
  billing.reset()
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  await db.delete(schema.tasks)
  await db.delete(schema.user_assets)
  await db.delete(schema.user_asset_objects)
  await db.delete(schema.user_looks)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER,
    username: USER,
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(USER, tx))}`
  await putAsset('cup', 'cup-1')
  await putAsset('lamp', 'lamp-1')
  await putLook('look-1')
})

describe('POST /api/looks/batch 积分预检', () => {
  it('积分不够整批时整批拒绝，报整批总价，一个任务都不建', async () => {
    // 余额 3 分、每张 1 分：第一条 2 张预扣得下，第二条 2 张不够。
    let balance = 3
    billing.decide = ({ quantity }) => {
      if (quantity > balance)
        return { kind: 'insufficient_credits', required: quantity, available: balance }
      balance -= quantity
      return { kind: 'reserved', credits: quantity }
    }

    const { status, json } = await batch({
      lookId: 'look-1',
      assetIds: ['cup', 'lamp'],
      perAsset: 2,
      device_id: DEVICE,
    })

    expect(status).toBe(402)
    expect(json).toEqual({ error: 'insufficient_credits', required: 4, available: 3 })
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    // 已归档的输入图一并清掉，只剩素材本身。
    expect((await storage.listPrefix('')).sort()).toEqual(
      [assetObjectKey(USER, 'cup-1'), assetObjectKey(USER, 'lamp-1')].sort(),
    )
  })

  it('积分够整批时照常全部建出来', async () => {
    const { status, json } = await batch({
      lookId: 'look-1',
      assetIds: ['cup', 'lamp'],
      perAsset: 2,
      device_id: DEVICE,
    })

    expect(status).toBe(200)
    expect(json.tasks).toHaveLength(2)
    expect(await db.select().from(schema.tasks)).toHaveLength(2)
    expect(billing.reservations.map((one) => one.quantity)).toEqual([2, 2])
  })
})
