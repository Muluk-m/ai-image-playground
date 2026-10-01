import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { ProjectDocument } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { TEST_IMAGE } from '../../../helpers/imageFixtures'
import { InMemoryObjectStore } from '../../../helpers/inMemoryObjectStore'

/**
 * 读画布这件事有两半，缺一半就是鸡肋：一半是「看得见画布上有什么」（本工具），另一半是
 * 「看见的图片 id 交得给 editImage」（`images.ts` 的画布 media 分支）。两半都钉在这里，
 * 因为它们共用同一条归属边界——只准读这一轮会话绑着的那个项目。
 */

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_read_canvas')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { readCanvas } = await import('../../../../lib/agent/tools/readCanvas')
const {
  archiveAgentReferences,
  claimConversationMedia,
  createAgentImageSource,
  removeAgentConversationReferences,
  readyCanvasMediaIds,
} = await import('../../../../lib/agent/images')
const { setDurableMediaStoreForTesting } = await import('../../../../lib/durableMediaStore')
const { close: closeDb, db, schema } = await import('../../../../db/client')
type AgentToolContext = Parameters<typeof readCanvas.create>[0]

const USER = 'user-canvas'
const OTHER = 'user-other'
const MEDIA = '11111111-2222-4333-8444-555555555555'

class DurableFixture extends InMemoryObjectStore {
  sign(key: string) {
    return `https://durable.example/${key}`
  }
}
let durable: DurableFixture

function context(conversationId: string, userId: string | null): AgentToolContext {
  return {
    mode: 'image',
    conversationId,
    turnId: 'turn-1',
    userId,
    deviceId: 'device-abcdefgh',
    images: createAgentImageSource({ references: [], history: [], conversationId, userId }),
  }
}

async function run(
  conversationId: string,
  userId: string | null,
  params: { query?: string; limit?: number } = {},
): Promise<string> {
  const result = await readCanvas
    .create(context(conversationId, userId))
    .execute('call-1', params, undefined, undefined)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('readCanvas should answer in text')
  return block.text
}

async function user(id: string): Promise<void> {
  const now = Date.now()
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
}
/** 会话归属二选一：`agent_conversations_owner_check` 只许用户或设备其中之一。 */
async function conversation(id: string, userId: string): Promise<string> {
  const now = Date.now()
  await db.insert(schema.agent_conversations).values({
    id,
    user_id: userId,
    device_id: null,
    title: '第一句',
    created_at: now,
    updated_at: now,
  })
  return id
}

async function project(input: {
  id: string
  userId: string
  conversationId: string | null
  document: ProjectDocument
  deleted?: boolean
}): Promise<void> {
  const now = Date.now()
  await db.insert(schema.canvas_projects).values({
    id: input.id,
    user_id: input.userId,
    name: '画布',
    revision: 7,
    document: input.document,
    element_count: input.document.elements.length,
    conversation_id: input.conversationId,
    receipts: [],
    created_at: now,
    updated_at: now,
    deleted_at: input.deleted ? now : null,
  })
}

/** 一张已经上传完的画布图片，挂在指定项目名下。 */
async function media(projectId: string, userId: string, id = MEDIA): Promise<void> {
  const now = Date.now()
  // 原件与预览给不同字节，这样断言能分清取回来的是哪一份。
  await durable.write(`media/${id}`, TEST_IMAGE.png, 'image/png')
  await durable.write(`preview/${id}`, TEST_IMAGE.webp, 'image/webp')
  await db.insert(schema.media_objects).values({
    id,
    user_id: userId,
    sha256: `sha-${id}`,
    bytes: TEST_IMAGE.png.byteLength,
    content_type: 'image/png',
    status: 'ready',
    reserved_bytes: 0,
    staging_key: `staging/${id}`,
    object_key: `media/${id}`,
    preview_key: `preview/${id}`,
    expires_at: now + 86_400_000,
    created_at: now,
    updated_at: now,
  })
  await db.insert(schema.media_references).values({
    user_id: userId,
    media_id: id,
    owner_kind: 'project',
    owner_id: projectId,
    created_at: now,
  })
}

function imageElement(mediaId = MEDIA) {
  return {
    id: 'el-image',
    type: 'image',
    mediaId,
    x: 10.4,
    y: 20.6,
    width: 512,
    height: 512,
    rotation: 0,
    name: '橘猫实拍',
  } as const
}

beforeEach(async () => {
  durable = new DurableFixture()
  setDurableMediaStoreForTesting(durable)
  await db.delete(schema.media_references)
  await db.delete(schema.media_objects)
  await db.delete(schema.canvas_projects)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.users)
  await user(USER)
  await user(OTHER)
})

afterAll(async () => {
  setDurableMediaStoreForTesting()
  await closeDb()
})

it('reports each element with the id that the image tools accept', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: {
      version: 1,
      elements: [
        {
          id: 'el-gen',
          type: 'generation',
          generationId: 'task-9',
          position: 2,
          x: 0,
          y: 0,
          width: 1024,
          height: 1024,
        },
        imageElement(),
        {
          id: 'el-text',
          type: 'text',
          x: 5,
          y: 6,
          text: '主标题',
          fontSize: 24,
          fill: '#000',
          width: 100,
          height: 30,
        },
      ],
    },
  })

  const text = await run('conv-1', USER)

  // 生成位报产物 id，用户放的图报 media id：两者都是 `editImage` 现在就认得的 id。
  expect(text).toContain('图片 id agent_task-9_2')
  expect(text).toContain(`图片 id ${MEDIA}`)
  // 元素 id 也在，但必须和图片 id 分开出现，否则模型会拿它去改图。
  expect(text).toContain('元素 el-image')
  expect(text).toContain('主标题')
  expect(text).toContain('共 3 个元素')
})

it('lists the batch, time and prompt excerpt a grouping pass can use without viewing pixels', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: {
      version: 1,
      elements: [
        {
          ...imageElement(),
          groupId: 'task-batch',
          createdAt: 1_700_000_000_000,
          meta: {
            prompt: `落在图上的生成提示词${'很长'.repeat(80)}`,
            userPrompt: '白底八仙角色',
          },
        },
      ],
    },
  })

  const text = await run('conv-1', USER)

  expect(text).toContain('同批 task-batch')
  expect(text).toContain('时间 1700000000000')
  expect(text).toContain('提示词「白底八仙角色」')
  expect(text).not.toContain('落在图上的生成提示词')
  expect(await run('conv-1', USER, { query: '八仙' })).toContain('橘猫实拍')
})

it('reports the canvas the user is looking at even when the server copy only has older images', async () => {
  const text = await readCanvas
    .create({
      mode: 'image',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      userId: null,
      deviceId: 'device-abcdefgh',
      images: { references: [], identify: () => undefined, attach: () => {} } as never,
      canvas: {
        elements: [
          { id: 'local-1', type: 'image', x: 0, y: 0, width: 10, height: 10, name: '海报' },
          { id: 'local-2', type: 'image', x: 20, y: 0, width: 10, height: 10, name: '二维码' },
          { id: 'local-3', type: 'image', x: 40, y: 0, width: 10, height: 10 },
        ],
      },
    })
    .execute('call-1', {}, undefined, undefined)

  const body = text.content[0]
  if (body?.type !== 'text') throw new Error('readCanvas should answer in text')
  expect(body.text).toContain('共 3 个元素')
  expect(body.text).toContain('用户此刻看见的')
  expect(body.text).toContain('海报')
  expect(body.text).toContain('二维码')
  expect(body.text).not.toContain('没有服务端画布')
})

it('continues through a large live canvas and reports missing elements honestly', async () => {
  const result = await readCanvas
    .create({
      ...context('conv-1', null),
      canvas: {
        elements: Array.from({ length: 205 }, (_, index) => ({
          id: `image-${index}`,
          type: 'image' as const,
          x: index * 20,
          y: 0,
          width: 10,
          height: 10,
        })),
        omitted: 3,
      },
    })
    .execute('call-1', { offset: 200 }, undefined, undefined)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('readCanvas should answer in text')
  expect(block.text).toContain('共 208 个元素')
  expect(block.text).toContain('还有 3 个没带上')
  expect(block.text).toContain('元素 image-200')
  expect(block.text).not.toContain('元素 image-0：')
})

it('keeps only the elements a keyword hits', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: {
      version: 1,
      elements: [
        imageElement(),
        {
          id: 'el-other',
          type: 'image',
          mediaId: '99999999-2222-4333-8444-555555555555',
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          rotation: 0,
          name: '背景纸纹',
        },
      ],
    },
  })

  const text = await run('conv-1', USER, { query: '橘猫' })

  expect(text).toContain('橘猫实拍')
  expect(text).not.toContain('背景纸纹')
})

// 画布是按用户存的：没登录的设备在服务端根本没有画布，不能让它落到别人的项目上。
it('tells the model there is no server-side canvas for a signed-out device', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [imageElement()] },
  })

  expect(await run('conv-1', null)).not.toContain(MEDIA)
})

it('refuses a project that another account owns', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: OTHER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [imageElement()] },
  })

  expect(await run('conv-1', USER)).not.toContain(MEDIA)
})

it('refuses a canvas that is in the trash', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [imageElement()] },
    deleted: true,
  })

  expect(await run('conv-1', USER)).not.toContain(MEDIA)
})

function sourceFor(conversationId: string, userId: string | null) {
  return createAgentImageSource({ references: [], history: [], conversationId, userId })
}

it('resolves a canvas image id straight into bytes', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [imageElement()] },
  })
  await media('proj-1', USER)

  const resolved = await sourceFor('conv-1', USER).resolve(MEDIA)

  expect(resolved?.dataUrl).toBe(TEST_IMAGE.pngDataUrl)
})

it('makes an uploaded image readable before the project document syncs', async () => {
  await conversation('conv-1', USER)
  const now = Date.now()
  await durable.write(`media/${MEDIA}`, TEST_IMAGE.png, 'image/png')
  await db.insert(schema.media_objects).values({
    id: MEDIA,
    user_id: USER,
    sha256: 'sha-unsynced',
    bytes: TEST_IMAGE.png.byteLength,
    content_type: 'image/png',
    status: 'ready',
    reserved_bytes: 0,
    staging_key: `staging/${MEDIA}`,
    object_key: `media/${MEDIA}`,
    expires_at: now + 86_400_000,
    created_at: now,
    updated_at: now,
  })
  expect(await sourceFor('conv-1', USER).resolve(MEDIA)).toBeNull()
  const ready = await readyCanvasMediaIds(USER, [MEDIA])
  expect(ready.has(MEDIA)).toBe(true)
  const inThisTurn = createAgentImageSource({
    references: [],
    history: [],
    conversationId: 'conv-1',
    userId: USER,
    canvasMediaIds: [...ready],
  })
  expect((await inThisTurn.resolve(MEDIA))?.dataUrl).toBe(TEST_IMAGE.pngDataUrl)
  expect((await inThisTurn.resolve(`aip-media:${MEDIA.toUpperCase()}`))?.dataUrl).toBe(
    TEST_IMAGE.pngDataUrl,
  )
  const [claims] = await db
    .select({ id: schema.media_references.media_id })
    .from(schema.media_references)
    .where(eq(schema.media_references.owner_id, 'conv-1'))
  expect(claims).toBeUndefined()
  expect(await sourceFor('conv-1', USER).resolve(MEDIA)).toBeNull()
})

// 看一眼判断「是不是那张图」用缩略图就够，原件一次几 MB 的 data URL 会直接把出站预算吃穿。
it('hands back the preview by default and the original only when asked', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [imageElement()] },
  })
  await media('proj-1', USER)
  const source = sourceFor('conv-1', USER)

  expect((await source.resolve(MEDIA, 'preview'))?.dataUrl).toBe(TEST_IMAGE.webpDataUrl)
  expect((await source.resolve(MEDIA, 'original'))?.dataUrl).toBe(TEST_IMAGE.pngDataUrl)
})

// 画布里存的来源写法是 `aip-media:<uuid>`，模型多半照抄。
it('accepts the aip-media form the canvas stores', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [imageElement()] },
  })
  await media('proj-1', USER)

  expect((await sourceFor('conv-1', USER).resolve(`aip-media:${MEDIA}`))?.dataUrl).toBe(
    TEST_IMAGE.pngDataUrl,
  )
})

// id 来自模型输出，而模型输出受用户文本影响：同一个人的另一张画布也不准读。
it('refuses a media id from the same account but another project', async () => {
  await conversation('conv-1', USER)
  await conversation('conv-2', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [] },
  })
  await project({
    id: 'proj-2',
    userId: USER,
    conversationId: 'conv-2',
    document: { version: 1, elements: [imageElement()] },
  })
  await media('proj-2', USER)

  expect(await sourceFor('conv-1', USER).resolve(MEDIA)).toBeNull()
})

/**
 * 用户在画布上选中图片附给这一轮：字节已经在 R2 里，请求只带 id。八张原图内联一次就是
 * 几十 MB 的请求体，传几分钟还白占一遍出站带宽——那条路 2026-09-23 把一轮拖到 400 打回。
 */
it('claims a user-attached media id for the conversation and reads it back', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [imageElement()] },
  })
  await media('proj-1', USER)

  expect(
    await claimConversationMedia('conv-1', USER, [{ imageId: 'el-image', mediaId: MEDIA }]),
  ).toBe(true)
  const stored = await archiveAgentReferences('conv-1', 'turn-1', [
    { imageId: 'el-image', mediaId: MEDIA, name: '橘猫实拍' },
  ])

  // 字节不复制第二遍：快照里只有 id。
  expect(stored).toEqual([{ imageId: 'el-image', mediaId: MEDIA, name: '橘猫实拍' }])
  const source = createAgentImageSource({
    references: [{ imageId: 'el-image', mediaId: MEDIA }],
    history: [],
    conversationId: 'conv-1',
    userId: USER,
  })
  expect((await source.resolve('el-image'))?.dataUrl).toBe(TEST_IMAGE.pngDataUrl)
})

// 会话自己那条认领是历史的锚：用户后来把这张图从画布上删了，历史里的引用还得读得出来。
it('keeps an attached media id readable after the canvas drops it', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [imageElement()] },
  })
  await media('proj-1', USER)
  await claimConversationMedia('conv-1', USER, [{ imageId: 'el-image', mediaId: MEDIA }])

  // 项目写入会把自己那批认领整批换掉；这张图不在画布上了，项目那条就没了。
  await db.delete(schema.media_references).where(eq(schema.media_references.owner_kind, 'project'))

  expect((await sourceFor('conv-1', USER).resolve(`aip-media:${MEDIA}`))?.dataUrl).toBe(
    TEST_IMAGE.pngDataUrl,
  )
})

// id 来自请求体，谁都能编一个：认领这一步就是越权边界，挡在起轮之前。
it('refuses to claim media that another account owns, or any media for a signed-out device', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: OTHER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [imageElement()] },
  })
  await media('proj-1', OTHER)

  expect(await claimConversationMedia('conv-1', USER, [{ imageId: 'el', mediaId: MEDIA }])).toBe(
    false,
  )
  expect(await claimConversationMedia('conv-1', null, [{ imageId: 'el', mediaId: MEDIA }])).toBe(
    false,
  )
  // 已经不在的 id 同样认领不上，那一轮不会开出去再失败。
  expect(
    await claimConversationMedia('conv-1', OTHER, [
      { imageId: 'el', mediaId: '00000000-2222-4333-8444-555555555555' },
    ]),
  ).toBe(false)
})

// 删会话要把认领一起清掉，否则 `media_references` 的 restrict 会把那几张图永远钉在配额里。
it('drops the conversation claim when the conversation goes', async () => {
  await conversation('conv-1', USER)
  await project({
    id: 'proj-1',
    userId: USER,
    conversationId: 'conv-1',
    document: { version: 1, elements: [imageElement()] },
  })
  await media('proj-1', USER)
  await claimConversationMedia('conv-1', USER, [{ imageId: 'el-image', mediaId: MEDIA }])

  await removeAgentConversationReferences('conv-1')

  const remaining = await db
    .select({ ownerKind: schema.media_references.owner_kind })
    .from(schema.media_references)
  expect(remaining.map((one) => one.ownerKind)).toEqual(['project'])
})
