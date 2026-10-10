import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { projectArtifactId } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { TEST_IMAGE_CHANNEL } from '../../../helpers/agentStubs'
import { TEST_IMAGE } from '../../../helpers/imageFixtures'
import { InMemoryObjectStore } from '../../../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../../../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('agent_conversation_images')
process.env.PORT = '0'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../../batch-plan-operator-config.json',
)
const billing = installRecordingTaskHooks()
const { db, schema, close } = await import('../../../../db/client')
const { agentTurnTools, agentToolDeclarations, agentToolGuidance } = await import(
  '../../../../lib/agent/tools'
)
const { createAgentImageSource } = await import('../../../../lib/agent/images')
const { readAgentBatchPlan } = await import('../../../../lib/agent/batch-plans')
const { _setChannelsForTesting } = await import('../../../../lib/channels')
const { setDurableMediaStoreForTesting } = await import('../../../../lib/durableMediaStore')
const { setObjectStoreForTesting } = await import('../../../../lib/objectStore')
const { appendAgentMessage } = await import('../../../../lib/agent/conversations')

const USER = 'conversation-images-owner'
const CONVERSATION = 'conversation-images-main'
class MediaStore extends InMemoryObjectStore {
  sign(key: string) {
    return `https://storage.example/${key}`
  }
}
const store = new MediaStore()

function context(conversationId = CONVERSATION, userId: string | null = USER) {
  return {
    mode: 'image' as const,
    experience: 'chat' as const,
    conversationId,
    turnId: crypto.randomUUID(),
    userId,
    deviceId: 'conversation-images-device',
    images: createAgentImageSource({ references: [], history: [], conversationId, userId }),
  }
}

async function runTool(name: string, args: unknown, turn = context()) {
  const tool = agentTurnTools(turn).find((candidate) => candidate.name === name)
  expect(tool).toBeDefined()
  return tool!.execute(crypto.randomUUID(), args, undefined, undefined)
}

async function list(args: unknown = {}, turn = context()) {
  const result = await runTool('readConversationImages', args, turn)
  const text = result.content[0]
  if (text?.type !== 'text') throw new Error('Expected a conversation image catalog')
  return JSON.parse(text.text)
}

async function generated(
  id: string,
  position: number,
  createdAt: number,
  conversationId = CONVERSATION,
) {
  const mediaId = crypto.randomUUID()
  await store.write(`original/${mediaId}`, TEST_IMAGE.png, 'image/png')
  await db.insert(schema.media_objects).values({
    id: mediaId,
    user_id: USER,
    sha256: mediaId,
    bytes: TEST_IMAGE.png.byteLength,
    content_type: 'image/png',
    status: 'ready',
    reserved_bytes: 0,
    staging_key: `staging/${mediaId}`,
    object_key: `original/${mediaId}`,
    width: 8,
    height: 8,
    expires_at: createdAt + 86_400_000,
    created_at: createdAt,
    updated_at: createdAt,
  })
  await db
    .insert(schema.generation_records)
    .values({
      id,
      user_id: USER,
      provider: 'openai-compat',
      model: 'gpt-image-1',
      status: 'completed',
      archive_status: 'ready',
      prompt: '星河科技 Logo',
      created_at: createdAt,
      revision: 1n,
      source: { kind: 'agent', conversationId, turnId: 'original-turn', projectId: null },
    })
    .onConflictDoNothing()
  await db
    .insert(schema.generation_images)
    .values({ generation_id: id, role: 'output', position, media_id: mediaId })
  await db.insert(schema.media_references).values({
    user_id: USER,
    media_id: mediaId,
    owner_kind: 'generation',
    owner_id: id,
    created_at: createdAt,
  })
  return { imageId: projectArtifactId(id, position), mediaId }
}

beforeAll(async () => {
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER,
    username: USER,
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  await db
    .insert(schema.agent_conversations)
    .values({ id: CONVERSATION, user_id: USER, title: 'Logo', created_at: now, updated_at: now })
  setDurableMediaStoreForTesting(store)
  setObjectStoreForTesting(new InMemoryObjectStore())
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
})

afterAll(async () => {
  setDurableMediaStoreForTesting()
  setObjectStoreForTesting()
  await close()
})

it('finds, views and freezes all three historical outputs without retained messages or queue tasks', async () => {
  const now = Date.now()
  const originals = [
    await generated('logo-orbit', 0, now),
    await generated('logo-letters', 0, now + 1),
    await generated('logo-star', 0, now + 2),
  ]
  const page = await list({ query: '星河科技' })
  expect(page.images.map((image: { imageId: string }) => image.imageId)).toEqual([
    'agent_logo-star_0',
    'agent_logo-letters_0',
    'agent_logo-orbit_0',
  ])
  const viewed = await runTool('viewImage', { imageIds: [originals[0]!.imageId], detail: 'full' })
  expect(
    viewed.content.some(
      (block) => block.type === 'image' && block.data === TEST_IMAGE.png.toString('base64'),
    ),
  ).toBe(true)
  const planned = await runTool('planImageBatch', {
    title: '三款 Logo 去字改白底',
    rule: '保留图形、去文字、白色实底',
    items: originals.map((original, index) => ({
      key: `logo-${index}`,
      imageIds: [original.imageId],
      prompt: '去掉文字并改成白色实底，保留图形',
      dependencies: [],
    })),
  })
  const pageOfPlan = await readAgentBatchPlan(USER, planned.details.batchId)
  expect(pageOfPlan?.batch.status).toBe('draft')
  expect(pageOfPlan?.items.map((item) => item.inputs)).toEqual(
    originals.map((original) => [original]),
  )
  expect(billing.reservations).toEqual([])
})

async function conversation(id: string) {
  const now = Date.now()
  await db
    .insert(schema.agent_conversations)
    .values({ id, user_id: USER, title: id, created_at: now, updated_at: now })
  return context(id)
}

it('paginates equal timestamps and multiple outputs without duplicates, including after a newer image arrives', async () => {
  const turn = await conversation('catalog-pagination')
  const now = Date.now()
  await generated('paged-a', 0, now, turn.conversationId)
  await generated('paged-a', 1, now, turn.conversationId)
  await generated('paged-b', 0, now, turn.conversationId)
  const first = await list({ limit: 2 }, turn)
  expect(first.images.map((image: { imageId: string }) => image.imageId)).toEqual([
    'agent_paged-b_0',
    'agent_paged-a_1',
  ])
  expect(first.nextCursor).toBeString()
  await generated('paged-new', 0, now + 100, turn.conversationId)
  const second = await list({ limit: 2, cursor: first.nextCursor }, turn)
  expect(second.images.map((image: { imageId: string }) => image.imageId)).toEqual([
    'agent_paged-a_0',
  ])
  expect(second.nextCursor).toBeNull()
  await expect(list({ cursor: 'bad-cursor' }, turn)).rejects.toThrow('翻页标记无效')
})

it('does not discover, view or plan with another conversation, another owner or a deleted output', async () => {
  const other = await conversation('catalog-private')
  const original = await generated('private-output', 0, Date.now(), other.conversationId)
  expect(
    (await list()).images.some((image: { imageId: string }) => image.imageId === original.imageId),
  ).toBe(false)
  expect((await list({}, context(CONVERSATION, 'another-owner'))).images).toEqual([])
  expect(await context().images.resolve(original.imageId)).toBeNull()
  await expect(
    runTool('planImageBatch', {
      title: 'wrong scope',
      rule: 'edit',
      items: [{ key: 'one', imageIds: [original.imageId], prompt: 'edit', dependencies: [] }],
    }),
  ).rejects.toThrow('没有可用的已保存原图')
  await db
    .update(schema.generation_records)
    .set({ deleted_at: Date.now() })
    .where(eq(schema.generation_records.id, 'private-output'))
  expect((await list({}, other)).images).toEqual([])
  expect(await other.images.resolve(original.imageId)).toBeNull()
})

it('finds an archived attachment outside the message window and edits it without reuploading or inheriting its old mask', async () => {
  const turn = await conversation('catalog-attachment')
  const original = await generated('attachment-original', 0, Date.now(), turn.conversationId)
  await db.insert(schema.media_references).values({
    user_id: USER,
    media_id: original.mediaId,
    owner_kind: 'conversation',
    owner_id: turn.conversationId,
    created_at: Date.now(),
  })
  await appendAgentMessage(db, {
    conversationId: turn.conversationId,
    turnId: 'upload-turn',
    role: 'user',
    content: [
      {
        type: 'text',
        text: '上传的 Logo',
        references: [
          {
            imageId: 'uploaded-logo',
            mediaId: original.mediaId,
            name: '我的标志',
            maskMediaId: 'old-mask',
          },
        ],
      },
    ],
  })
  const catalog = await list({ query: '我的标志' }, turn)
  expect(catalog.images).toMatchObject([
    {
      imageId: 'uploaded-logo',
      source: 'attachment',
      messageId: expect.any(String),
      available: true,
    },
  ])
  const resolved = await turn.images.resolve('uploaded-logo')
  expect(resolved?.dataUrl).toBe(TEST_IMAGE.pngDataUrl)
  expect(resolved?.maskDataUrl).toBeUndefined()
  const edited = await runTool(
    'editImage',
    { prompt: '去字改白底', imageIds: ['uploaded-logo'] },
    turn,
  )
  expect(edited.details.awaitingConfirmation).toBe(true)
  expect(edited.details.job).toBeUndefined()
  expect(billing.reservations).toEqual([])
})

it('keeps unavailable originals visible as unavailable and never falls back to an older task payload', async () => {
  const turn = await conversation('catalog-unavailable')
  const original = await generated('unavailable-output', 0, Date.now(), turn.conversationId)
  await db.insert(schema.tasks).values({
    id: 'unavailable-output',
    user_id: USER,
    provider: 'openai-compat',
    model: 'gpt-image-1',
    status: 'completed',
    submitted_at: Date.now(),
    agent_conversation_id: turn.conversationId,
    request_payload: { prompt: 'old pixels' },
    result_payload: {
      data: [{ b64_json: TEST_IMAGE.png.toString('base64'), mime: 'image/png' }],
    },
  })
  await db
    .update(schema.media_objects)
    .set({ status: 'deleting' })
    .where(eq(schema.media_objects.id, original.mediaId))
  expect((await list({}, turn)).images).toMatchObject([
    { imageId: original.imageId, available: false },
  ])
  expect(await turn.images.resolve(original.imageId)).toBeNull()
  await expect(
    runTool(
      'planImageBatch',
      {
        title: 'unavailable',
        rule: 'edit',
        items: [{ key: 'one', imageIds: [original.imageId], prompt: 'edit', dependencies: [] }],
      },
      turn,
    ),
  ).rejects.toThrow('没有可用的已保存原图')
  await db
    .update(schema.media_objects)
    .set({ status: 'ready' })
    .where(eq(schema.media_objects.id, original.mediaId))
  await appendAgentMessage(db, {
    conversationId: turn.conversationId,
    turnId: 'replace-turn',
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'replacement',
        references: [
          { imageId: original.imageId, image: { object: 'replacement', mime: 'image/png' } },
        ],
      },
    ],
  })
  expect((await list({}, turn)).images).toMatchObject([
    { imageId: original.imageId, source: 'attachment', available: false },
  ])
  expect(await turn.images.resolve(original.imageId)).toBeNull()
  await db
    .update(schema.agent_conversations)
    .set({ deleted_at: Date.now() })
    .where(eq(schema.agent_conversations.id, turn.conversationId))
  expect((await list({}, turn)).images).toEqual([])
  expect(await turn.images.resolve(original.imageId)).toBeNull()
})

it('exposes the catalog, declarations and guidance to signed-in image and video turns only', () => {
  for (const mode of ['image', 'video'] as const) {
    const turn = { ...context(), mode }
    expect(agentTurnTools(turn).map((tool) => tool.name)).toContain('readConversationImages')
    expect(agentToolDeclarations(mode, turn).map((tool) => tool.name)).toContain(
      'readConversationImages',
    )
    expect(agentToolGuidance(mode, turn).some((line) => line.includes('先查会话图片'))).toBe(true)
    expect(agentTurnTools({ ...turn, userId: null }).map((tool) => tool.name)).not.toContain(
      'readConversationImages',
    )
  }
})

it('still views delivered task outputs in deployments without durable generation archival', async () => {
  const turn = await conversation('catalog-no-sync')
  const id = 'legacy-no-sync'
  await db.insert(schema.tasks).values({
    id,
    user_id: USER,
    provider: 'openai-compat',
    model: 'gpt-image-1',
    status: 'completed',
    submitted_at: Date.now(),
    agent_conversation_id: turn.conversationId,
    request_payload: { prompt: 'legacy' },
    result_payload: {
      data: [{ b64_json: TEST_IMAGE.png.toString('base64'), mime: 'image/png' }],
    },
  })
  await db.insert(schema.generation_records).values({
    id,
    user_id: USER,
    provider: 'openai-compat',
    model: 'gpt-image-1',
    status: 'completed',
    archive_status: 'none',
    prompt: 'legacy',
    created_at: Date.now(),
    revision: 1n,
    source: {
      kind: 'agent',
      conversationId: turn.conversationId,
      turnId: 'legacy-turn',
      projectId: null,
    },
  })
  expect((await turn.images.resolve(projectArtifactId(id, 0)))?.dataUrl).toBe(TEST_IMAGE.pngDataUrl)
  await db
    .update(schema.generation_records)
    .set({ deleted_at: Date.now() })
    .where(eq(schema.generation_records.id, id))
  expect(await turn.images.resolve(projectArtifactId(id, 0))).toBeNull()
})

it('preserves retained legacy outputs with unknown source without bypassing unavailable media', async () => {
  const turn = await conversation('catalog-unknown-source')
  const original = await generated('unknown-source', 0, Date.now(), turn.conversationId)
  await db
    .update(schema.generation_records)
    .set({ source: null })
    .where(eq(schema.generation_records.id, 'unknown-source'))
  await db.insert(schema.tasks).values({
    id: 'unknown-source',
    user_id: USER,
    provider: 'openai-compat',
    model: 'gpt-image-1',
    status: 'completed',
    submitted_at: Date.now(),
    agent_conversation_id: turn.conversationId,
    request_payload: { prompt: 'legacy' },
    result_payload: {
      data: [{ b64_json: TEST_IMAGE.png.toString('base64'), mime: 'image/png' }],
    },
  })
  expect((await turn.images.resolve(original.imageId))?.dataUrl).toBe(TEST_IMAGE.pngDataUrl)
  await db
    .update(schema.media_objects)
    .set({ status: 'deleting' })
    .where(eq(schema.media_objects.id, original.mediaId))
  expect(await turn.images.resolve(original.imageId)).toBeNull()
})
