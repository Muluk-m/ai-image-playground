import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } from '../../lib/private-overlay'

process.env.DATABASE_URL = await resetTestDatabase('agent_stage_authorizations')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../stage-authorization-operator-config.json')
let actualCredits = 6
_setPrivateBffOverlayForTesting({
  ...EMPTY_PRIVATE_BFF_OVERLAY, present: true,
  taskHooks: {
    ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
    async quoteTask({ model, quantity, unitMultiplier }) {
      return { estimatedCredits: 6 * quantity, pricing: { model, quantity, unitMultiplier, unit: 'image', pricingVersion: 'fixture', quotedAt: Date.now(), validUntil: null, baseUnitCredits: 6, outputPriceRatio: 0, cachedInputPriceRatio: 0, inputEstimateTokens: 0, outputReserveTokens: 0, exemption: 'none' } }
    },
    async reserveTask() { return { kind: 'reserved', credits: actualCredits } },
  },
})
// Module loading must follow isolated DATABASE_URL and billing-boundary installation.
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createNodes, runNodes } = await import('../../lib/agent/tools/nodeCanvas')
const { createAgentImageSource } = await import('../../lib/agent/images')
let cookie: string
beforeAll(async () => {
  await db.insert(schema.users).values({ id: 'stage-owner', username: 'stage-owner', password_hash: 'unused', status: 'active', created_at: Date.now(), updated_at: Date.now() })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('stage-owner', tx))}`
})
afterAll(close)
async function fixture(estimatedCredits = 10, nodeIds = ['a']) {
  const conversationId = crypto.randomUUID(), projectId = crypto.randomUUID(), now = Date.now()
  await db.insert(schema.agent_conversations).values({ id: conversationId, user_id: 'stage-owner', title: '授权', created_at: now, updated_at: now })
  await db.insert(schema.canvas_projects).values({ id: projectId, user_id: 'stage-owner', conversation_id: conversationId, name: '授权', document: { version: 1, elements: [] }, revision: 1, receipts: [], element_count: 0, created_at: now, updated_at: now })
  const context = { mode: 'image' as const, experience: 'canvas' as const, conversationId, turnId: 'turn', deviceId: 'stage-device', userId: 'stage-owner', canvas: { selectedNodeIds: [], elements: [] }, images: createAgentImageSource({ references: [], history: [], conversationId, userId: 'stage-owner' }), autoSubmit: { take: () => { throw new Error('Canvas must not consume per-turn quota') } } }
  await createNodes.create(context).execute('create', { nodes: [{ id: 'a', type: 'image', prompt: '嫩芽' }, { id: 'b', type: 'image', prompt: '树' }] }, undefined, undefined)
  const result = await runNodes.create(context).execute('proposal', { stage: '素材', nodeIds, estimatedCredits }, undefined, undefined)
  return result.details!.canvasRun!
}
async function request(id: string, action = '', body?: unknown, authenticated = true) {
  return app.handle(new Request(`http://localhost/api/agent/stage-authorizations/${id}${action}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authenticated ? { cookie } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
}
it('persists a pending scoped proposal and activates once without granting execution to replays', async () => {
  const proposal = await fixture()
  expect(proposal).toMatchObject({ stage: '素材', nodeIds: ['a'], estimatedCredits: 10, status: 'pending' })
  expect(proposal).not.toHaveProperty('autoRun')
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({ status: 'pending', spentCredits: 0, budgetCap: 10 })
  const confirmed = await request(proposal.authorizationId, '/confirm', {})
  expect(confirmed.status).toBe(200)
  const receipt = await confirmed.json()
  expect(receipt.authorization.status).toBe('active')
  expect(typeof receipt.executionToken).toBe('string')
  expect((await request(proposal.authorizationId, '/confirm', {})).status).toBe(409)
  const restored = await (await request(proposal.authorizationId)).json()
  expect(restored).not.toHaveProperty('executionToken')
  expect(restored.audit.map((event: { kind: string }) => event.kind)).toEqual(['proposed', 'confirmed'])
  expect((await request(proposal.authorizationId, '', undefined, false)).status).toBe(401)
})
it('preflights only active authorized nodes, deduplicates attempts and ends before submission', async () => {
  const proposal = await fixture()
  const job = { nodeId: 'a', model: 'gpt-image-1', quantity: 1, unitMultiplier: 1 }
  expect((await request(proposal.authorizationId, '/preflight', { ...job, executionToken: 'not-active', attemptId: 'attempt' })).status).toBe(409)
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  expect((await request(proposal.authorizationId, '/preflight', { ...job, nodeId: 'b', executionToken, attemptId: 'outside' })).status).toBe(409)
  expect((await request(proposal.authorizationId, '/preflight', { ...job, executionToken, attemptId: 'attempt' })).status).toBe(200)
  expect((await request(proposal.authorizationId, '/preflight', { ...job, executionToken, attemptId: 'another-attempt' })).status).toBe(409)
  const ended = await (await request(proposal.authorizationId, '/end', {})).json()
  expect(ended.status).toBe('ended')
  expect(ended.spentCredits).toBe(0)
  expect((await request(proposal.authorizationId, '/preflight', { ...job, executionToken, attemptId: 'late' })).status).toBe(409)
})

it('rejects server-priced requests over budget before any task can start', async () => {
  const proposal = await fixture(5)
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  const result = await request(proposal.authorizationId, '/preflight', { nodeId: 'a', model: 'gpt-image-1', quantity: 1, unitMultiplier: 1, executionToken, attemptId: 'expensive' })
  expect(result.status).toBe(409)
  expect(await result.json()).toMatchObject({ error: 'stage_authorization_budget' })
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({ spentCredits: 0, attempts: [] })
})

it('atomically accounts real queue costs, rejects overspend and deduplicates accepted submissions', async () => {
  const proposal = await fixture(6)
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  await request(proposal.authorizationId, '/preflight', { nodeId: 'a', model: 'gpt-image-1', quantity: 1, unitMultiplier: 1, executionToken, attemptId: 'one' })
  const body = { prompt: '嫩芽', device_id: 'stage-test-device', client_request_id: crypto.randomUUID(), stage_authorization: { authorizationId: proposal.authorizationId, executionToken, attemptId: 'one', nodeId: 'a' } }
  const submit = () => app.handle(new Request('http://localhost/v1/queue/openai-compat/gpt-image-1/submit', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  actualCredits = 7
  expect((await submit()).status).toBe(409)
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({ spentCredits: 0 })
  actualCredits = 6
  const [first, duplicate] = await Promise.all([submit(), submit()])
  expect(first.status).toBe(200)
  expect(duplicate.status).toBe(200)
  const accepted = await first.json()
  expect((await duplicate.json()).request_id).toBe(accepted.request_id)
  const state = await (await request(proposal.authorizationId)).json()
  expect(state).toMatchObject({ status: 'exhausted', spentCredits: 6 })
  expect(state.attempts[0].taskIds).toEqual([accepted.request_id])
  expect(state.audit.filter((event: { kind: string }) => event.kind === 'submitted')).toHaveLength(1)
  expect(state).not.toHaveProperty('executionToken')
})

it('serializes simultaneous budget reservations across two authorized nodes', async () => {
  const proposal = await fixture(10, ['a', 'b'])
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  const responses = await Promise.all(['a', 'b'].map((nodeId) => request(proposal.authorizationId, '/preflight', { nodeId, model: 'gpt-image-1', quantity: 1, unitMultiplier: 1, executionToken, attemptId: nodeId })))
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
  const state = await (await request(proposal.authorizationId)).json()
  expect(state.attempts).toHaveLength(1)
  expect(state.spentCredits).toBe(0)
})
