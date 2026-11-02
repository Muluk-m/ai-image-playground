import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'

process.env.DATABASE_URL = await resetTestDatabase('gpt_premium_route')
process.env.PORT = '0'
process.env.GPT_DIRECT_ENABLED = 'true'
process.env.OPENAI_API_KEY = 'direct-key'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../agent-chat-free-operator-config.json',
)

const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
const { gptPremiumRoutes } = await import('../../routes/gpt-premium')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')

const app = new Elysia().use(gptPremiumRoutes)
const USER_ID = 'gpt-premium-user'
let sessionToken = ''
let members = new Set<string>()

_setPrivateBffOverlayForTesting({
  ...EMPTY_PRIVATE_BFF_OVERLAY,
  taskHooks: {
    ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
    isActiveMember: async ({ userId }) => members.has(userId),
  },
})

const premium = async (cookie = `${USER_SESSION_COOKIE}=${sessionToken}`) => {
  const res = await app.handle(
    new Request('http://localhost/api/gpt/premium', { headers: { cookie } }),
  )
  return { status: res.status, body: res.status === 200 ? await res.json() : null }
}

beforeEach(async () => {
  members = new Set()
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'gpt.premium',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  sessionToken = await db.transaction((tx) => createUserSession(USER_ID, tx))
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

it('unlocks the premium GPT tiers only for a member while OpenAI direct is on', async () => {
  expect(await premium()).toEqual({ status: 200, body: { premium: false } })
  members.add(USER_ID)
  expect(await premium()).toEqual({ status: 200, body: { premium: true } })
})

it('requires a signed-in account', async () => {
  expect((await premium('')).status).toBe(401)
})
