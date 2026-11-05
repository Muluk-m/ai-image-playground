import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_overview_window')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

const writer = createDb(databaseUrl)
const now = Date.now()
const day = 86_400_000
const from = now - day
const to = now

await writer.db.insert(writer.schema.users).values({
  id: 'window-user',
  username: 'window-user',
  password_hash: 'x',
  created_at: now - 3600_000,
  updated_at: now - 3600_000,
})
await writer.db.insert(writer.schema.agent_conversations).values({
  id: 'window-conversation',
  user_id: 'window-user',
  title: 'window',
  created_at: now - 3600_000,
  updated_at: now - 3600_000,
})
await writer.db.insert(writer.schema.agent_turns).values({
  conversation_id: 'window-conversation',
  turn_id: 'turn',
  duration_ms: 1000,
  stop_reason: 'completed',
  created_at: now - 30_000,
})

const task = (
  id: string,
  model: string,
  request_payload: Record<string, unknown>,
  upstream_invocation_count: number,
) => ({
  id,
  provider: 'openai-compat' as const,
  model,
  status: 'completed' as const,
  request_payload: request_payload as never,
  submitted_at: now - 60_000,
  started_at: now - 50_000,
  completed_at: now - 40_000,
  upstream_invocation_count,
})

await writer.db.insert(writer.schema.tasks).values([
  task('still', 'gpt-image-2', { prompt: 'still', device_id: 'dev', n: 2 }, 4),
  task('decimal-n', 'gpt-image-2-decimal', { prompt: 'half', device_id: 'dev', n: 2.5 }, 5),
  task(
    'gif',
    'gpt-image-2.6-flare',
    { prompt: 'crane', device_id: 'dev', output_format: 'gif', frame_count: 6, n: 'gif' },
    3,
  ),
  task(
    'svg',
    'gpt-image-2.6-sunburst',
    {
      prompt: 'logo',
      device_id: 'dev',
      output_format: 'svg',
      n: { model: 'gpt-6-sol' },
    },
    2,
  ),
  task('video', 'video-model', { prompt: 'clip', device_id: 'dev', n: 'svg', video: {} }, 5),
])
await writer.db.insert(writer.schema.agent_model_calls).values([
  {
    id: 'usage-int',
    conversation_id: 'window-conversation',
    turn_id: 'turn-int',
    device_id: 'dev',
    purpose: 'conversation',
    model: 'chat-int',
    status: 'completed',
    usage: { inputTokens: 100, outputTokens: 10 },
    cache_read_tokens: 10,
    http_dispatch_count: 1,
    started_at: now - 20_000,
  },
  {
    id: 'usage-decimal',
    conversation_id: 'window-conversation',
    turn_id: 'turn-decimal',
    device_id: 'dev',
    purpose: 'conversation',
    model: 'chat-decimal',
    status: 'completed',
    usage: { inputTokens: 12.5, outputTokens: 3.2 },
    cache_read_tokens: 4,
    http_dispatch_count: 1,
    started_at: now - 10_000,
  },
  {
    id: 'usage-junk',
    conversation_id: 'window-conversation',
    turn_id: 'turn-junk',
    device_id: 'dev',
    purpose: 'conversation',
    model: 'chat-junk',
    status: 'completed',
    usage: { inputTokens: 'not-a-number', outputTokens: 1e21 } as never,
    cache_read_tokens: 99,
    http_dispatch_count: 1,
    started_at: now - 5_000,
  },
])

const { app } = await import('../../../../server/app')

afterAll(async () => {
  await writer.close()
})

async function login(): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.176' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return response.headers.get('set-cookie')!.split(';')[0]!
}

describe('overview today window', () => {
  it('loads today when n is not an integer and usage contains decimals', async () => {
    const cookie = await login()
    const overview = await app.handle(
      new Request(`http://localhost/api/overview?from=${from}&to=${to}`, { headers: { cookie } }),
    )
    expect(overview.status).toBe(200)
    const body = (await overview.json()) as {
      pulse: { current: { tasks: number; images: number; active: number } }
      models: Array<{ model: string; average_multiplier: number | null }>
      agent_cache: {
        calls: number
        input_tokens: number
        cache_read_tokens: number
        models: Array<{ model: string }>
      }
    }
    expect(body.pulse.current.tasks).toBe(5)
    // 2 张、2.5 张截成 2、GIF/SVG 的 n 不是数字按 1 张，视频不算。
    expect(body.pulse.current.images).toBe(6)
    expect(body.pulse.current.active).toBe(2)
    expect(body.models).toEqual([
      expect.objectContaining({ model: 'gpt-image-2', average_multiplier: 2 }),
      expect.objectContaining({ model: 'gpt-image-2-decimal', average_multiplier: 2.5 }),
      expect.objectContaining({ model: 'gpt-image-2.6-flare', average_multiplier: 3 }),
      expect.objectContaining({ model: 'gpt-image-2.6-sunburst', average_multiplier: 2 }),
      expect.objectContaining({ model: 'video-model', average_multiplier: 5 }),
    ])
    expect(body.agent_cache).toMatchObject({
      calls: 2,
      input_tokens: 112.5,
      cache_read_tokens: 14,
    })
    expect(body.agent_cache.models.map((model) => model.model)).toEqual([
      'chat-int',
      'chat-decimal',
    ])

    expect(
      (
        await app.handle(
          new Request('http://localhost/api/overview/today', { headers: { cookie } }),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await app.handle(
          new Request('http://localhost/api/overview/errors', { headers: { cookie } }),
        )
      ).status,
    ).toBe(200)
  })
})
