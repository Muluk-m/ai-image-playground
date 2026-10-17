import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'
import { installRecordingTaskHooks } from './__tests__/helpers/privateOverlayStub'

const requests: Record<string, unknown>[] = []
const upstream = Bun.serve({ port: 0, fetch: async (request) => {
  requests.push(await request.json() as Record<string, unknown>)
  const chunk = { id: 'canvas-smoke', object: 'chat.completion.chunk', created: 1, model: 'fixture-agent-model', choices: [{ index: 0, delta: { role: 'assistant', content: '青禾推开山门。' }, finish_reason: null }] }
  const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.DATABASE_URL = await resetTestDatabase('canvas_http_smoke')
process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${upstream.port}`
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '__tests__/agent-billing-operator-config.json')
const billing = installRecordingTaskHooks()
billing.pricing = { outputPriceRatio: 2, outputReserveTokens: 2000 }
const { textGenerationRoutes } = await import('./routes/textGeneration')
const { db, schema, close } = await import('./db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('./lib/user-session')
await db.insert(schema.users).values({ id: 'http-smoke', username: 'canvas.smoke', password_hash: 'unused', status: 'active', created_at: Date.now(), updated_at: Date.now() })
const cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('http-smoke', tx))}`
const app = new Elysia().use(textGenerationRoutes).listen(0)
try {
 const base = `http://127.0.0.1:${app.server!.port}/api/canvas/text`
 const directory = await fetch(`${base}/models`, { headers: { cookie } })
 assert.equal(directory.status, 200)
 const catalog = await directory.json() as { defaultModel: string }
 const response = await fetch(base, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ model: catalog.defaultModel, deviceId: 'canvas-http-smoke', instruction: '扩写开场', currentText: '山海学徒', references: [{ id: 'character', kind: 'text', text: '主角叫青禾' }] }) })
 assert.equal(response.status, 200, await response.clone().text())
 assert.deepEqual(await response.json(), { text: '青禾推开山门。' })
 assert.equal(requests.length, 1)
 assert.equal(requests[0]?.model, 'fixture-agent-model')
 assert.ok(JSON.stringify(requests[0]?.messages).includes('主角叫青禾'))
 assert.equal(billing.reservations.length, 1)
 assert.equal(billing.settlements[0]?.outcome, 'completed')
 const [task] = await db.select().from(schema.tasks)
 assert.equal(task?.status, 'completed')
 console.log(JSON.stringify({ smoke: 'canvas-text-http', status: response.status, selectedModel: requests[0]?.model, taskStatus: task?.status, reservationCount: billing.reservations.length, settlement: billing.settlements[0]?.outcome }))
} finally {
 await app.stop()
 upstream.stop()
 await close()
}
