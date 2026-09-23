import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import sharp from 'sharp'
import { InMemoryObjectStore } from '../../../helpers/inMemoryObjectStore'

/**
 * 取网图这件事有两半，缺一半就是鸡肋：一半是「把网上的字节收进来」，另一半是「收进来的
 * 那个 id 交得给 editImage」。两半都钉在这里——它们由同一条认领串起来：字节落进
 * `media_objects`，会话认领落进 `media_references`，`images.ts` 的画布 media 分支才读得到。
 */

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_fetch_image')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
// 取网图要写进这个人的媒体库，还要部署开着联网：两道闸都在这份配置里。
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../../agent-fetch-image-operator-config.json',
)

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { fetchImage } = await import('../../../../lib/agent/tools/fetchImage')
const { agentToolDeclarations } = await import('../../../../lib/agent/tools')
const { createAgentImageSource } = await import('../../../../lib/agent/images')
const { _setSafeFetchForTesting } = await import('../../../../lib/safeFetch')
const { setDurableMediaStoreForTesting } = await import('../../../../lib/durableMediaStore')
const { close: closeDb, db, schema } = await import('../../../../db/client')
type AgentToolContext = Parameters<typeof fetchImage.create>[0]

const USER = 'user-fetch'
const CONVERSATION = 'conv-fetch'
const PUBLIC_ADDRESS = '93.184.216.34'

const PNG = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#4488cc' } })
  .png()
  .toBuffer()
/** sharp 认得、媒体库不原样收的格式：这条路要转成 PNG 才存得下去。 */
const TIFF = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#cc8844' } })
  .tiff()
  .toBuffer()

class DurableFixture extends InMemoryObjectStore {
  sign(key: string) {
    return `https://durable.example/${key}`
  }
}
let durable: DurableFixture

/** 这一轮的上下文；断言要拿它回头问「那个 id 现在取得到字节吗」。 */
function context(userId: string | null = USER): AgentToolContext {
  return {
    mode: 'image',
    conversationId: CONVERSATION,
    turnId: 'turn-1',
    userId,
    deviceId: 'device-abcdefgh',
    images: createAgentImageSource({
      references: [],
      history: [],
      conversationId: CONVERSATION,
      userId,
    }),
  }
}

/** 网络全程假：DNS 给一个公网地址，传输交回我们喂进去的字节。 */
function serve(body: Uint8Array | string, contentType: string, address = PUBLIC_ADDRESS): void {
  _setSafeFetchForTesting({
    resolve: async () => [{ address, family: 4 }],
    // 复制一份：`Uint8Array<ArrayBufferLike>` 不是 BodyInit，拷出来的才落在 ArrayBuffer 上。
    fetch: async () =>
      new Response(typeof body === 'string' ? body : new Uint8Array(body), {
        status: 200,
        headers: { 'content-type': contentType },
      }),
  })
}

async function run(url: string, params: Record<string, unknown> = {}, ctx = context()) {
  const result = await fetchImage.create(ctx).execute('call-1', { url, ...params })
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('fetchImage should lead with text')
  return { details: result.details, text: block.text, blocks: result.content, context: ctx }
}

beforeEach(async () => {
  durable = new DurableFixture()
  setDurableMediaStoreForTesting(durable)
  await db.delete(schema.media_references)
  await db.delete(schema.media_objects)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER,
    username: USER,
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  await db.insert(schema.agent_conversations).values({
    id: CONVERSATION,
    user_id: USER,
    device_id: null,
    title: '第一句',
    created_at: now,
    updated_at: now,
  })
})

afterAll(async () => {
  _setSafeFetchForTesting()
  setDurableMediaStoreForTesting()
  await closeDb()
})

/**
 * 收进来的那个 id 必须就是普通的图片 id：这是整件事的意义，取回来却交不给 editImage
 * 就只是往媒体库里塞了一张没人看得见的图。
 */
it('stores the image and hands back an id the image tools can resolve', async () => {
  serve(PNG, 'image/png')

  const {
    details,
    text,
    blocks,
    context: ctx,
  } = await run('https://example.com/cat.png', {
    name: '橘猫实拍',
  })

  const fetched = details.fetchedImages?.[0]
  expect(fetched).toMatchObject({
    sourceUrl: 'https://example.com/cat.png',
    mime: 'image/png',
    width: 8,
    height: 6,
    name: '橘猫实拍',
  })
  expect(text).toContain(fetched!.imageId)
  expect(text).toContain('https://example.com/cat.png')
  // 模型看一眼的那张缩略图跟在文字后面，不然它只拿到一串 id。
  expect(blocks.slice(1).map((one) => one.type)).toEqual(['image'])

  // 认领是这张图的读路径，也是越权边界：会话认得它，editImage 才取得到字节。
  const claims = await db
    .select({
      ownerKind: schema.media_references.owner_kind,
      ownerId: schema.media_references.owner_id,
      mediaId: schema.media_references.media_id,
    })
    .from(schema.media_references)
  expect(claims).toEqual([
    { ownerKind: 'conversation', ownerId: CONVERSATION, mediaId: fetched!.imageId },
  ])
  const resolved = await ctx.images.resolve(fetched!.imageId)
  expect(resolved?.dataUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
})

// 网图什么格式都有。sharp 认得的先转成 PNG，不然媒体库连收都不收。
it('converts a format the media library will not take and stores it as png', async () => {
  serve(TIFF, 'image/tiff')

  const { details, context: ctx } = await run('https://example.com/swatch.tiff')

  expect(details.fetchedImages?.[0]).toMatchObject({ mime: 'image/png', width: 5, height: 4 })
  expect((await ctx.images.resolve(details.fetchedImages![0]!.imageId))?.dataUrl).toStartWith(
    'data:image/png;base64,',
  )
})

/** 地址多半指向承载图片的网页：告诉模型换一个，别把整轮停下。 */
it('refuses bytes that are not an image', async () => {
  serve('<html><body>not an image</body></html>', 'text/html')

  const thrown = await run('https://example.com/cat').catch((error: unknown) => error)

  expect(thrown).toMatchObject({ code: 'invalid_params' })
  expect((thrown as Error).message).toContain('不是图片')
  expect(await db.select({ id: schema.media_objects.id }).from(schema.media_objects)).toEqual([])
})

// 地址是模型写的，指向内网就是一次 SSRF：拒绝也要归成「换个网址」，不是「重试」。
it('refuses a host that resolves into the private network', async () => {
  serve(PNG, 'image/png', '10.0.0.5')

  const thrown = await run('https://intranet.example/cat.png').catch((error: unknown) => error)

  expect(thrown).toMatchObject({ code: 'invalid_params' })
  expect((thrown as Error).message).toContain('内网')
})

/** 媒体库是这个人的东西：没登录的那一轮根本不该看见这个工具。 */
it('stays out of the tool list for a turn with no user', () => {
  expect(agentToolDeclarations('image').map((one) => one.name)).not.toContain('fetchImage')
  expect(agentToolDeclarations('image', { userId: USER }).map((one) => one.name)).toContain(
    'fetchImage',
  )
})
