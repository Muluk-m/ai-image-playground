import { afterAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'

const temp = await mkdtemp(join(tmpdir(), 'production-export-'))
await writeFile(
  join(temp, 'operator.json'),
  JSON.stringify({ capabilities: { 'agent:chat': true, 'agent:production': true } }),
)
process.env.DATABASE_URL = await resetTestDatabase('production_export')
process.env.OPERATOR_CONFIG_FILE = join(temp, 'operator.json')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://upstream.test'
process.env.UPSTREAM_API_KEY = 'test-key'
const { productionRoutes } = await import('../../routes/production')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createAgentConversation } = await import('../../lib/agent/conversations')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { assetObjectKey } = await import('../../lib/sync-assets')
const { InMemoryObjectStore } = await import('../helpers/inMemoryObjectStore')
const app = new Elysia().use(productionRoutes)
async function account(id: string) {
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  const token = await db.transaction((tx) => createUserSession(id, tx))
  const conversation = await createAgentConversation({ kind: 'user', userId: id }, '依赖关系')
  return { userId: id, id: conversation.id, cookie: `${USER_SESSION_COOKIE}=${token}` }
}
async function request(owner: { id: string; cookie: string }, body?: unknown, suffix = '') {
  return app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/production${suffix}`, {
      method: body ? (suffix ? 'POST' : 'PUT') : 'GET',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
it('inspects only snapshot resources without reading bytes, streams originals, and preserves expired history membership', async () => {
  const owner = await account('export-owner')
  const stranger = await account('export-stranger')
  const storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  try {
    for (const imageId of ['original', 'unselected'])
      await db.insert(schema.user_asset_objects).values({
        user_id: owner.userId,
        image_id: imageId,
        bytes: 3,
        content_type: 'image/png',
        created_at: Date.now(),
      })
    const reference = { kind: 'asset', imageId: 'original' }
    const key = assetObjectKey(owner.userId, 'original')
    await storage.write(key, new Uint8Array([1, 2, 3]), 'image/png')
    const content = {
      title: '导出',
      setting: '',
      outline: '',
      scenes: [],
      locations: [{ id: 'station', name: '站台', description: '', reference }],
    }
    expect((await request(owner, { operationId: 'create', baseRevision: 0, content })).status).toBe(
      200,
    )
    storage.events.length = 0
    const inspected = await request(
      owner,
      { revision: 1, references: [reference] },
      '/export/inspect',
    )
    expect(inspected.status).toBe(200)
    expect(await inspected.json()).toEqual({
      items: [{ reference, bytes: 3, mime: 'image/png', status: 'available' }],
    })
    expect(storage.events).toEqual([`open:${key}`])
    expect(
      (
        await request(
          { ...owner, cookie: stranger.cookie },
          { revision: 1, references: [reference] },
          '/export/inspect',
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await request(
          owner,
          { revision: 1, references: [{ kind: 'asset', imageId: 'unselected' }] },
          '/export/inspect',
        )
      ).status,
    ).toBe(404)
    const download = await request(
      owner,
      undefined,
      '/export/reference?revision=1&kind=asset&id=original&download=true',
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(storage.events).toContain(`stream:${key}:0-2`)
    expect(storage.events.some((event) => event.startsWith('read:'))).toBe(false)
    expect(
      (
        await request(owner, {
          operationId: 'remove',
          baseRevision: 1,
          content: { ...content, locations: [] },
        })
      ).status,
    ).toBe(200)
    expect(
      (await request(owner, { revision: 2, references: [reference] }, '/export/inspect')).status,
    ).toBe(404)
    storage.objects.delete(key)
    const expired = await request(
      owner,
      { revision: 1, references: [reference] },
      '/export/inspect',
    )
    expect(await expired.json()).toEqual({
      items: [{ reference, bytes: null, mime: 'image/png', status: 'missing' }],
    })
    expect(
      (await request(owner, undefined, '/export/reference?revision=1&kind=asset&id=original'))
        .status,
    ).toBe(404)
  } finally {
    setObjectStoreForTesting(undefined)
  }
})
it('exports owned completed video candidates by frozen document membership and rejects foreign or invalid output identities', async () => {
  const owner = await account('video-export-owner')
  const foreign = await account('video-export-foreign')
  const storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  try {
    const created = await (
      await request(owner, {
        operationId: 'start',
        baseRevision: 0,
        content: { title: '视频', setting: '', outline: '', scenes: [] },
      })
    ).json()
    const { projectArtifactId } = await import('@image-playground/shared')
    for (const [taskId, userId] of [
      ['video-result', owner.userId],
      ['foreign-result', foreign.userId],
    ]) {
      await db.insert(schema.tasks).values({
        id: taskId!,
        user_id: userId!,
        agent_conversation_id: owner.id,
        provider: 'openai-compat',
        model: 'grok-imagine-video',
        status: 'completed',
        request_payload: { prompt: '列车' },
        result_payload: { data: [{ object: 'video-original', mime: 'video/mp4' }] },
        submitted_at: Date.now(),
      })
      await db.insert(schema.agent_generation_drafts).values({
        id: `draft-${taskId}`,
        conversation_id: owner.id,
        turn_id: `turn-${taskId}`,
        tool_call_id: 'call',
        tool_name: 'generateVideo',
        media: 'video',
        provider: 'openai-compat',
        model: 'grok-imagine-video',
        prompt: '列车',
        request: { prompt: '列车' },
        submission: {
          review: false,
          production: {
            documentId: created.document.id,
            revision: 1,
            target: 'clip',
            targetId: 'clip',
            snapshot: { name: '列车', description: '列车', references: [], shotIds: [] },
          },
        },
        task_id: taskId!,
        created_at: Date.now(),
      })
    }
    await storage.write(
      'video-original',
      new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      'video/mp4',
    )
    storage.events.length = 0
    const reference = { kind: 'artifact', artifactId: projectArtifactId('video-result', 0) }
    const inspected = await request(
      owner,
      { revision: 1, references: [reference] },
      '/export/inspect',
    )
    expect(inspected.status).toBe(200)
    expect(await inspected.json()).toEqual({
      items: [{ reference, bytes: 8, mime: 'video/mp4', status: 'available' }],
    })
    expect(storage.events).toEqual(['open:video-original'])
    const response = await request(
      owner,
      undefined,
      `/export/reference?revision=1&kind=artifact&id=${encodeURIComponent(reference.artifactId)}`,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    )
    for (const artifactId of [
      projectArtifactId('foreign-result', 0),
      projectArtifactId('video-result', 9),
    ])
      expect(
        (
          await request(
            owner,
            { revision: 1, references: [{ kind: 'artifact', artifactId }] },
            '/export/inspect',
          )
        ).status,
      ).toBe(404)
  } finally {
    setObjectStoreForTesting(undefined)
  }
})
afterAll(async () => {
  await close()
  await rm(temp, { recursive: true, force: true })
})
