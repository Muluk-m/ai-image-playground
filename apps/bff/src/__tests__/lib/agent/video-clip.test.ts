import { afterAll, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentToolContext } from '../../../lib/agent/tools/types'
import type { ObjectRangeReader, ObjectStore } from '../../../lib/objectStore'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_video_clip')
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.LOG_LEVEL = 'silent'

const { close: closeDb, db, schema } = await import('../../../db/client')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { readVideoClip } = await import('../../../lib/agent/video-clip')

afterAll(async () => {
  setObjectStoreForTesting()
  await closeDb()
})

function context(): AgentToolContext {
  return {
    mode: 'video',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    userId: 'user-1',
    deviceId: 'device-abcdefgh',
    images: { identify: (id: string) => id } as AgentToolContext['images'],
  }
}

async function completedVideo(id: string, item: Record<string, unknown>): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: 'video-model',
    status: 'completed',
    submitted_at: Date.now(),
    agent_conversation_id: 'conversation-1',
    request_payload: { device_id: 'device-abcdefgh', prompt: '一段片子' },
    result_payload: { data: [item] },
  })
}

it('stops an object read when the tool is cancelled and passes that signal through', async () => {
  await db.delete(schema.tasks)
  await completedVideo('task-object', { object: 'clips/one.mp4', mime: 'video/mp4' })
  const controller = new AbortController()
  let opened: (signal?: AbortSignal) => void = () => {}
  const started = new Promise<AbortSignal | undefined>((resolve) => {
    opened = resolve
  })
  const store: ObjectStore = {
    async write() {},
    async read() {
      return new Uint8Array()
    },
    open(_key, signal) {
      opened(signal)
      return new Promise<ObjectRangeReader>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('missing signal'))
          return
        }
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    async listPrefix() {
      return []
    },
    async listEntries() {
      return []
    },
    async deletePrefix() {},
  }
  setObjectStoreForTesting(store)

  const pending = readVideoClip(context(), 'agent_task-object_0', controller.signal)
  expect(await started).toBe(controller.signal)
  controller.abort()
  await expect(pending).rejects.toBeInstanceOf(DOMException)
})

it('stops a url download when the tool is cancelled instead of waiting out its own timeout', async () => {
  let requested: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    requested = resolve
  })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      requested()
      return new Promise(() => {})
    },
  })
  try {
    await db.delete(schema.tasks)
    await completedVideo('task-url', {
      url: `http://127.0.0.1:${server.port}/clip.mp4`,
      mime: 'video/mp4',
    })
    const controller = new AbortController()
    const pending = readVideoClip(context(), 'agent_task-url_0', controller.signal)
    await started
    controller.abort()
    const failed = await pending.then(
      (clip) => clip,
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(DOMException)
    expect(failed).not.toMatchObject({ ok: false })
  } finally {
    await server.stop(true)
  }
})
