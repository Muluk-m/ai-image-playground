import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import sharp from 'sharp'
import { InMemoryObjectStore } from '../../../helpers/inMemoryObjectStore'

/**
 * 抓商品图与取网图共用同一条落库路径，所以这里只钉它自己那一段：从一页 HTML 里认出哪几张
 * 是商品图、只放行亚马逊自家图片 CDN、取回来的 id 照样是普通图片 id（editImage 拿得动）。
 */

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_fetch_listing')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../../agent-fetch-image-operator-config.json',
)

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { fetchListingImages } = await import('../../../../lib/agent/tools/fetchListingImages')
const { agentToolDeclarations } = await import('../../../../lib/agent/tools')
const { createAgentImageSource } = await import('../../../../lib/agent/images')
const { _setSafeFetchForTesting } = await import('../../../../lib/safeFetch')
const { setDurableMediaStoreForTesting } = await import('../../../../lib/durableMediaStore')
const { close: closeDb, db, schema } = await import('../../../../db/client')
type AgentToolContext = Parameters<typeof fetchListingImages.create>[0]

const USER = 'user-listing'
const CONVERSATION = 'conv-listing'
const PUBLIC_ADDRESS = '93.184.216.34'
const LISTING_URL = 'https://www.amazon.com/Some-Product-Name/dp/B0BSHF7WHW/ref=sr_1_1?keywords=x'
const CDN = 'https://m.media-amazon.com/images/I'

const PNG = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#4488cc' } })
  .png()
  .toBuffer()

/** 线上那一页的形状：图集 JSON 里的 hiRes 是大图，`\/` 是它转义过的斜杠。 */
const PAGE = `<!doctype html><html><head><title>Amazon.com</title></head><body>
<span id="productTitle" class="a-size-large"> Wooden Desk Lamp </span>
<script>var data = {"colorImages":{"initial":[
{"hiRes":"${CDN}\\/61fd2oCrvyL._AC_SL1500_.jpg","large":"${CDN}\\/61fd2oCrvyL._AC_SX466_.jpg"},
{"hiRes":"${CDN}\\/71ZAeHYYlHL._AC_SL1500_.jpg"},
{"hiRes":"${CDN}\\/81j1XDaqcML._AC_SL1500_.jpg"},
{"hiRes":"https://evil.example/images/I/steal.jpg"},
{"hiRes":"https://m.media-amazon.com/images/G/01/site-banner.jpg"}
]}};</script>
</body></html>`

class DurableFixture extends InMemoryObjectStore {
  sign(key: string) {
    return `https://durable.example/${key}`
  }
}
let durable: DurableFixture

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
/** `safeFetch` 把连接钉在解析出来的 IP 上，原主机名走 Host 头，所以断言要看这两处。 */
interface Request {
  readonly url: string
  readonly host: string | null
  readonly userAgent: string | null
  readonly acceptLanguage: string | null
}
let requests: Request[] = []

/** 网络全程假：商品页交回给定 HTML，图片地址交回一张真 PNG。 */
function serve(page: string, image: Uint8Array | null = PNG): void {
  requests = []
  _setSafeFetchForTesting({
    resolve: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      requests.push({
        url,
        host: headers.get('host'),
        userAgent: headers.get('user-agent'),
        acceptLanguage: headers.get('accept-language'),
      })
      if (url.includes('/images/I/')) {
        if (!image) return new Response('nope', { status: 404 })
        return new Response(new Uint8Array(image), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })
    },
  })
}

async function run(params: Record<string, unknown>, ctx = context()) {
  const result = await fetchListingImages.create(ctx).execute('call-1', params)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('fetchListingImages should lead with text')
  return { details: result.details, text: block.text, blocks: result.content, context: ctx }
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error) {
    const thrown = error as { code?: unknown; message?: unknown }
    return { code: String(thrown.code), message: String(thrown.message) }
  }
  throw new Error('expected the tool to fail')
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

it('按商品页取回整套主图，交回的 id 就是普通图片 id', async () => {
  serve(PAGE)

  const { details, text, blocks, context: ctx } = await run({ url: LISTING_URL, count: 3 })

  const images = details?.fetchedImages ?? []
  expect(images).toHaveLength(3)
  // 规范地址：查询串与 ref 段都不带进请求。
  expect(requests[0]?.host).toBe('www.amazon.com')
  expect(new URL(requests[0]?.url ?? '').pathname).toBe('/dp/B0BSHF7WHW')
  // 不带浏览器 UA 与英文 Accept-Language，亚马逊回的是验证码页。
  expect(requests[0]?.userAgent).toContain('Chrome/')
  expect(requests[0]?.acceptLanguage).toBe('en-US,en;q=0.9')
  // 白名单外的地址与站点素材都不进清单。
  expect(requests.map((one) => one.host)).not.toContain('evil.example')
  expect(requests.some((one) => one.url.includes('site-banner'))).toBe(false)
  expect(images[0]?.sourceUrl).toBe(`${CDN}/61fd2oCrvyL._AC_SL1500_.jpg`)
  expect(images[0]?.name).toContain('Wooden Desk Lamp')
  expect(text).toContain(`图片 id ${images[0]?.imageId}`)
  expect(blocks.filter((one) => one.type === 'image')).toHaveLength(3)

  // 这一条才是意义所在：取回来的 id 交得给 editImage。
  const resolved = await ctx.images.resolve(images[0]!.imageId, 'original')
  expect(resolved?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
})

it('默认只取主图那几张，不把整页图集全取下来', async () => {
  serve(PAGE)

  const { details } = await run({ url: LISTING_URL })

  expect(details?.fetchedImages).toHaveLength(3)
  expect(requests).toHaveLength(4)
})

it('不是商品页地址时交回模型能换掉的失败', async () => {
  serve(PAGE)

  const error = await failure(run({ url: 'https://www.amazon.com/s?k=desk+lamp' }))

  expect(error.code).toBe('invalid_params')
  expect(requests).toHaveLength(0)
})

it('页面里一张商品图也没有时说清是被挡了', async () => {
  serve('<!doctype html><html><body>Enter the characters you see below</body></html>')

  const error = await failure(run({ url: LISTING_URL }))

  expect(error.code).toBe('upstream_error')
  expect(error.message).toContain('验证码')
})

it('解析出了地址却一张都取不下来时，不留下半张卡', async () => {
  serve(PAGE, null)

  const error = await failure(run({ url: LISTING_URL }))

  expect(error.code).toBe('upstream_error')
  expect(await db.select().from(schema.media_objects)).toHaveLength(0)
})

it('没登录的那一轮里根本不挂这个工具', () => {
  expect(agentToolDeclarations('image').map((one) => one.name)).not.toContain('fetchListingImages')
  expect(agentToolDeclarations('image', { userId: USER }).map((one) => one.name)).toContain(
    'fetchListingImages',
  )
})
