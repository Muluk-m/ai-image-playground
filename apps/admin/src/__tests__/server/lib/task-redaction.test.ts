import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import {
  redactTaskRequestPayload,
  redactUpstreamBody,
} from '../../../../server/lib/redact-task-detail'

const databaseUrl = await resetTestDatabase('admin_task_redaction')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.BFF_INTERNAL_URL = 'http://127.0.0.1:39999'
process.env.PORT = '0'

const writer = createDb(databaseUrl)
const now = Date.now()
const dataUrl = `data:image/png;base64,${'A'.repeat(80)}`
await writer.db.insert(writer.schema.tasks).values({
  id: 'secret-task',
  provider: 'gemini',
  model: 'gemini-3-pro',
  status: 'failed',
  request_payload: {
    prompt: 'keep this prompt',
    model: 'gemini-3-pro',
    size: '1024x1024',
    n: 2,
    authorization: 'Bearer super-secret',
    apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
    input_images: [dataUrl],
    contents: [
      {
        parts: [
          { text: 'caption' },
          { inlineData: { mimeType: 'image/png', data: 'B'.repeat(200) } },
        ],
      },
    ],
  } as never,
  error_message: 'upstream rejected Bearer sk-abcdefghijklmnopqrstuvwxyz',
  error_type: 'upstream_error',
  upstream_status: 401,
  upstream_body:
    '{"error":{"message":"bad key Bearer sk-abcdefghijklmnopqrstuvwxyz","type":"invalid_api_key","code":"upstream_auth"}}',
  submitted_at: now,
  upstream_invocation_count: 1,
})

const { getTask } = await import('../../../../server/lib/queries')

afterAll(() => writer.close())

describe('redactTaskRequestPayload', () => {
  it('drops credentials and image bytes and keeps the prompt, size, and model', () => {
    const redacted = redactTaskRequestPayload({
      prompt: 'keep this prompt',
      size: '1024x1024',
      nested: { client_secret: 'hidden', note: 'https://user:pass@files.example/a' },
      input_images: [dataUrl],
    }) as {
      prompt: string
      size: string
      nested: { client_secret: string; note: string }
      input_images: string[]
    }
    expect(redacted.prompt).toBe('keep this prompt')
    expect(redacted.size).toBe('1024x1024')
    expect(redacted.nested.client_secret).toBe('[REDACTED]')
    expect(redacted.nested.note).toContain('[REDACTED]@files.example')
    expect(redacted.nested.note).not.toContain('user:pass')
    expect(redacted.input_images).toEqual(['[BINARY REDACTED]'])
  })
})

describe('getTask', () => {
  it('returns a redacted detail and still shows the upstream error code', async () => {
    const task = await getTask('secret-task')
    expect(task).not.toBeNull()
    const payload = task!.request_payload as {
      prompt: string
      model: string
      size: string
      n: number
      authorization: string
      apiKey: string
      input_images: string[]
      contents: Array<{
        parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>
      }>
    }
    expect(payload.prompt).toBe('keep this prompt')
    expect(payload.model).toBe('gemini-3-pro')
    expect(payload.size).toBe('1024x1024')
    expect(payload.n).toBe(2)
    expect(payload.authorization).toBe('[REDACTED]')
    expect(payload.apiKey).toBe('[REDACTED]')
    expect(payload.input_images).toEqual(['[BINARY REDACTED]'])
    expect(payload.contents[0]?.parts[0]?.text).toBe('caption')
    expect(payload.contents[0]?.parts[1]?.inlineData?.mimeType).toBe('image/png')
    expect(payload.contents[0]?.parts[1]?.inlineData?.data).toBe('[BINARY REDACTED]')
    expect(task!.error_message).toBe('upstream rejected Bearer [REDACTED]')
    expect(task!.error_message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(task!.error_type).toBe('upstream_error')
    expect(task!.upstream_status).toBe(401)
    expect(task!.upstream_body).toContain('invalid_api_key')
    expect(task!.upstream_body).toContain('upstream_auth')
    expect(task!.upstream_body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(redactUpstreamBody(task!.upstream_body)).toBe(task!.upstream_body)
    const [stored] = await writer.db
      .select({ request_payload: writer.schema.tasks.request_payload })
      .from(writer.schema.tasks)
      .where(eq(writer.schema.tasks.id, 'secret-task'))
    expect(JSON.stringify(stored?.request_payload)).toContain('keep this prompt')
    expect(JSON.stringify(stored?.request_payload)).toContain('sk-abcdefghijklmnopqrstuvwxyz')
  })
})
