import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import {
  controlledCompletion,
  parseFrames,
  readFrames,
  recordingAgentFetch,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_interjection_persistence')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { settleInboxHandoffsForTesting } = await import('../../lib/agent/start-turn')
const { db, close } = await import('../../db/client')
await silenceChatUpstream()
afterAll(close)
const app = new Elysia().use(agentRoutes)
const deviceId = 'interjection-persistence-device'
function post(path: string, body: unknown) {
  return app.handle(
    new Request(`http://localhost/api/agent/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

it('插话等待的助手写入失败仍是持久化失败，不能被插话错误处理吞掉后正常收尾', async () => {
  const upstream = controlledCompletion()
  setAgentFetchForTesting(recordingAgentFetch([], (signal) => upstream.responseFor(signal)))
  let releaseArchive!: () => void
  let archiving!: () => void
  const archived = new Promise<void>((resolve) => {
    archiving = resolve
  })
  const archiveGate = new Promise<void>((resolve) => {
    releaseArchive = resolve
  })
  class DelayedArchive extends InMemoryObjectStore {
    override async write(
      key: string,
      bytes: Uint8Array,
      contentType: string,
      signal?: AbortSignal,
    ) {
      if (key.includes('/interjections/')) {
        archiving()
        await archiveGate
      }
      await super.write(key, bytes, contentType, signal)
    }
  }
  setObjectStoreForTesting(new DelayedArchive())
  const { conversation } = await (await post('conversations', { deviceId })).json()
  const live = await post(`conversations/${conversation.id}/turns`, { deviceId, text: '先聊聊' })
  upstream.push('已经看见的回复')
  const seen = await readFrames(live, 3)
  const start = seen[0]!.event
  const turnId = start.type === 'turnStart' ? start.turnId : ''
  const resumed = app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${conversation.id}/turns/${turnId}/events`,
      {
        headers: { [DEVICE_ID_HEADER]: deviceId, 'last-event-id': String(seen.at(-1)!.id) },
      },
    ),
  )
  await db.execute(sql`CREATE FUNCTION refuse_assistant_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(8731045);
      RAISE EXCEPTION 'fixture assistant persistence failure';
    END $$`)
  await db.execute(
    sql`CREATE TRIGGER refuse_assistant_write BEFORE INSERT ON agent_messages FOR EACH ROW WHEN (NEW.role = 'assistant') EXECUTE FUNCTION refuse_assistant_write()`,
  )
  let unlock!: () => void
  let acquired!: () => void
  const released = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const locked = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const holding = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(8731045)`)
    acquired()
    await released
  })
  await locked
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ddeeff' } })
    .png()
    .toBuffer()
  const interjected = post(`conversations/${conversation.id}/turns/${turnId}/interject`, {
    deviceId,
    text: '补充一张图',
    references: [
      { imageId: 'reference', dataUrl: `data:image/png;base64,${png.toString('base64')}` },
    ],
  })
  try {
    await archived
    upstream.finish()
    await waitFor(
      async () =>
        (
          await db.execute(
            sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = 8731045::oid AND NOT granted`,
          )
        ).length > 0,
    )
    releaseArchive()
    // Admit after closeOpen captured the earlier write, before that write fails.
    await new Promise<void>((resolve) => setImmediate(resolve))
    unlock()
    await holding
    expect((await interjected).status).toBe(500)
    const frames = parseFrames(await (await resumed).text())
    expect(frames.at(-1)!.event).toMatchObject({
      type: 'turnEnd',
      stopReason: 'failed',
      error: 'agent_run_failed',
    })
  } finally {
    releaseArchive()
    unlock()
    await holding
    await interjected
    await settleInboxHandoffsForTesting()
    await db.execute(sql`DROP TRIGGER refuse_assistant_write ON agent_messages`)
    await db.execute(sql`DROP FUNCTION refuse_assistant_write()`)
    setAgentFetchForTesting()
    setObjectStoreForTesting()
  }
})
