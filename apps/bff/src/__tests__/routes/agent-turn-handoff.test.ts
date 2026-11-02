import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import { completionStream, parseFrames, recordingAgentFetch } from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_turn_handoff')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// 匿名设备、不计费：这里只看一轮收尾与下一条消息的先后。
installRecordingTaskHooks()

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { conversationHandoffWaitersForTesting } = await import('../../lib/agent/start-turn')
const { close: closeDb, db, schema } = await import('../../db/client')

await silenceChatUpstream()

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-handoff-abcdefgh'
const RELEASE_LOCK = 4_242_002

async function post(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

// 上一轮的终帧与响应流先结束，放手租约、去收件箱看一眼在那之后。这期间发来的下一句若先进收件箱，
// 收尾的接力会把它当成排着的消息抢去开轮，发送方只拿到 202 排队回执。这里把放手卡在数据库里，
// 确认发送方停在交接前，放行之后它自己开轮、拿到自己的流。
it('上一轮还在收尾时发来的下一句，等收尾交接完自己开轮并拿到自己的流', async () => {
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }

  let unlock!: () => void
  const barrier = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const { promise: acquired, resolve: locked } = Promise.withResolvers<void>()
  const holding = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${RELEASE_LOCK})`)
    locked()
    await barrier
  })
  await acquired
  await db.execute(
    sql.raw(
      `CREATE FUNCTION hold_turn_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state = 'completed' AND OLD.state = 'running' THEN PERFORM pg_advisory_xact_lock(${RELEASE_LOCK}); END IF; RETURN NEW; END $$`,
    ),
  )
  await db.execute(
    sql`CREATE TRIGGER hold_turn_release BEFORE UPDATE ON agent_executions FOR EACH ROW EXECUTE FUNCTION hold_turn_release()`,
  )
  try {
    const first = await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '第一句',
    })
    expect(parseFrames(await first.text()).at(-1)?.event).toMatchObject({
      type: 'turnEnd',
      stopReason: 'completed',
    })
    // 响应流已经结束，放手租约还卡着。
    await waitFor(
      async () =>
        (
          await db.execute(
            sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = ${RELEASE_LOCK}::oid AND NOT granted`,
          )
        ).length > 0,
      5_000,
    )

    const second = post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '第二句',
    })
    await waitFor(() => conversationHandoffWaitersForTesting(conversation.id) === 1, 5_000)
    // 收尾还没做完，第二句也还没进收件箱：接力没有东西可抢。
    expect(await db.select().from(schema.agent_inbox)).toHaveLength(1)
    unlock()
    await holding

    const response = await second
    expect(response.status).toBe(200)
    const events = parseFrames(await response.text()).map((frame) => frame.event)
    expect(events.map((event) => event.type)).not.toContain('queuedMessageConsumed')
    expect(events.at(-1)).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
  } finally {
    unlock()
    await holding
    await db.execute(sql`DROP TRIGGER hold_turn_release ON agent_executions`)
    await db.execute(sql`DROP FUNCTION hold_turn_release()`)
  }
})
