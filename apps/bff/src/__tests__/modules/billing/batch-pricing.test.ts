import { afterAll, afterEach, beforeAll, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import {
  completionStream,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../../helpers/agentStubs'
import { silenceChatUpstream } from '../../helpers/chatStubs'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'
import { fixturePng } from '../../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('private_agent_batch_pricing')
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config-batch.json')
process.env.INTERNAL_API_TOKEN = 'batch-pricing-service'
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(process.env.DATABASE_URL)
const { _setPrivateBffOverlayForTesting } = await import('../../../lib/private-overlay')
_setPrivateBffOverlayForTesting()
const { app } = await import('../../../app')
const { setAgentFetchForTesting } = await import('../../../lib/agent/model')
const { _setChannelsForTesting } = await import('../../../lib/channels')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../../lib/durableMediaStore')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../../lib/user-session')
const { db, schema, close } = await import('../../../db/client')
await silenceChatUpstream()

class MediaStorage extends InMemoryObjectStore {
  sign(key: string, method: 'GET' | 'PUT') {
    return `https://storage.example.test/${key}?method=${method}`
  }
}
const storage = new MediaStorage()
const DEVICE = 'batch-plan-device'
let cookie = ''

beforeAll(async () => {
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'batch-plan-owner',
    username: 'batch-plan-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('batch-plan-owner', tx))}`
  setDurableMediaStoreForTesting(storage)
  setObjectStoreForTesting(new InMemoryObjectStore())
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
})
afterEach(() => setAgentFetchForTesting())
afterAll(close)

function request(
  path: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
  requestCookie = cookie,
) {
  return app.handle(
    new Request(`http://localhost/api/${path}`, {
      method,
      headers: {
        cookie: requestCookie,
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: DEVICE,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

async function upload(background: string) {
  const bytes = await fixturePng(background)
  const response = await request('media/uploads', {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType: 'image/png',
    purpose: 'conversation-attachment',
  })
  expect(response.status).toBe(200)
  const media = await response.json()
  await storage.write(new URL(media.uploadUrl).pathname.slice(1), bytes, 'image/png')
  expect((await request(`media/${media.id}/complete`, {})).status).toBe(200)
  return media.id as string
}

async function setPrice(credits: number) {
  const response = await app.handle(
    new Request(
      `http://localhost/internal/admin/private/billing/models/${TEST_IMAGE_CHANNEL.models[0]!.id}`,
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer batch-pricing-service',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ credits_per_image: credits, active: true, unit: 'image' }),
      },
    ),
  )
  expect(response.status).toBe(200)
}

it('真实单价产生逐项报价快照，刷新不改旧报价，修订按新价且不预扣生成', async () => {
  await setPrice(7)
  const first = await upload('#112233')
  const second = await upload('#778899')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'priced-plan',
            name: 'planImageBatch',
            args: {
              title: '白底计划',
              rule: '换白底',
              items: [
                { key: 'a', imageIds: ['a'], prompt: '红色包装换白底', dependencies: [] },
                { key: 'b', imageIds: ['b'], prompt: '蓝色包装换白底', dependencies: [] },
              ],
            },
          }),
        () => completionStream('请确认范围与费用'),
      ],
    ),
  )
  const before = await (await request('billing/account')).json()
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '拟定两张图的计划',
      references: [
        { imageId: 'a', mediaId: first },
        { imageId: 'b', mediaId: second },
      ],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  const path = `agent/batches/${batches[0].id}`
  const initial = await (await request(path)).json()
  expect(initial.batch.estimate.generation).toMatchObject({
    status: 'available',
    estimatedCredits: 14,
    estimatedChargeCredits: 14,
  })
  expect(initial.batch.estimate.generation.snapshots).toHaveLength(2)
  expect(initial.batch.estimate.generation.snapshots[0]).toMatchObject({
    model: TEST_IMAGE_CHANNEL.models[0]!.id,
    baseUnitCredits: 7,
    unit: 'image',
    quantity: 1,
    unitMultiplier: 1,
    outputPriceRatio: 0,
    cachedInputPriceRatio: 0,
    inputEstimateTokens: 0,
    outputReserveTokens: 0,
    exemption: 'none',
    validUntil: null,
  })
  expect(initial.batch.estimate.generation.snapshots[0].pricingVersion).toBeString()
  await setPrice(11)
  const restored = await (await request(path)).json()
  expect(restored.batch.estimate).toEqual(initial.batch.estimate)
  const update = await request(
    path,
    { expectedVersion: 1, title: '新价格的计划', rule: '换白底', items: initial.items },
    'PATCH',
  )
  expect(update.status).toBe(200)
  const revised = await update.json()
  expect(revised.batch.estimate.generation).toMatchObject({
    status: 'available',
    estimatedCredits: 22,
    estimatedChargeCredits: 22,
  })
  expect(revised.batch.estimate.generation.snapshots[0].pricingVersion).not.toBe(
    initial.batch.estimate.generation.snapshots[0].pricingVersion,
  )
  const after = await (await request('billing/account')).json()
  expect(after.account).toEqual(before.account)
  const ledger = await (await request('billing/ledger')).json()
  expect(ledger.ledger).toEqual(before.ledger)
})
