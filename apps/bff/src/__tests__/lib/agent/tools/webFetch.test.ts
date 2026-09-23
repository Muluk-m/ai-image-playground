import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'

// 抓网页一条 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-web-fetch'
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../../agent-web-tools-operator-config.json',
)

// 动态引入：环境要先钉死，再让捕获配置的模块加载；静态 import 会在赋值之前就把配置读走。
const { webFetch } = await import('../../../../lib/agent/tools/webFetch')
const { _setSafeFetchForTesting } = await import('../../../../lib/safeFetch')
const { createAgentImageSource } = await import('../../../../lib/agent/images')
const { agentTurnTools } = await import('../../../../lib/agent/tools')

const PAGE_URL = 'https://shop.example.com/products/chair?v=2'

const HTML = `<!doctype html><html><head><title>  Oak Lounge Chair — Example </title>
<meta property="og:image" content="/social/hero.png">
<script>var a = "<div>not content</div>";</script>
</head><body>
<nav><a href="/home">Home</a></nav>
<main>
  <h1>Oak Lounge Chair</h1>
  <p>A solid oak frame with a <a href="/wool?c=1&amp;s=2">wool seat</a> &amp; brass feet.</p>
  <ul><li>Seat height 42cm</li></ul>
  <img src="pics/chair.jpg?w=800&amp;fm=webp" alt="the chair &quot;oak&quot;" width="800" height="600">
  <img src="/px.gif" width="1" height="1">
  <img src="/logo.svg" alt="logo">
</main>
<footer>© 2026</footer>
</body></html>`

/** 公网地址一个就够；SSRF 那一层只关心「解析出来的每一条都是公网」。 */
const PUBLIC = [{ address: '93.184.216.34', family: 4 }]

function serve(body: string, contentType: string, address = PUBLIC) {
  _setSafeFetchForTesting({
    resolve: async () => address,
    fetch: async () => new Response(body, { headers: { 'content-type': contentType } }),
  })
}

function context() {
  return {
    mode: 'image' as const,
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    userId: null,
    deviceId: 'device-abcdefgh',
    images: createAgentImageSource({
      references: [],
      history: [],
      conversationId: 'conversation-1',
      userId: null,
    }),
  }
}

async function run(params: { url: string; focus?: string }): Promise<{
  text: string
  sources: unknown
}> {
  const result = await webFetch.create(context()).execute('call-1', params, undefined, undefined)
  const block = result.content[0]
  return {
    text: block?.type === 'text' ? block.text : '',
    sources: result.details?.sources,
  }
}

beforeEach(() => {
  _setSafeFetchForTesting()
})

afterAll(() => {
  _setSafeFetchForTesting()
})

it('部署开了 agent:web，模型这一轮就看得见读取网页', () => {
  expect(agentTurnTools(context()).map((tool) => tool.name)).toContain('webFetch')
})

it('把网页压成 markdown，链接与图片候选都还原成绝对地址', async () => {
  serve(HTML, 'text/html; charset=utf-8')

  const { text, sources } = await run({ url: PAGE_URL })

  expect(text).toContain('# Oak Lounge Chair')
  // 源码里的实体要解开：图片地址里的 `&amp;` 原样递给取图工具，请求的就是另一个网址。
  expect(text).toContain('[wool seat](https://shop.example.com/wool?c=1&s=2) & brass feet.')
  expect(text).toContain('- Seat height 42cm')
  // 导航、脚本、页脚整块丢掉。
  expect(text).not.toContain('not content')
  expect(text).not.toContain('© 2026')
  expect(text).not.toContain('Home')
  // 图片候选按相对路径还原；社交卡片的主图排在前面，计数像素与矢量图标不进清单。
  expect(text).toContain('图片候选：')
  expect(text).toContain('- https://shop.example.com/social/hero.png')
  expect(text).toContain(
    '- https://shop.example.com/products/pics/chair.jpg?w=800&fm=webp （the chair "oak"）',
  )
  expect(text).not.toContain('px.gif')
  expect(text).not.toContain('logo.svg')
  expect(sources).toEqual([{ title: 'Oak Lounge Chair — Example', url: PAGE_URL }])
})

it('地址指向内网时交回一个模型能换掉的失败', async () => {
  serve(HTML, 'text/html', [{ address: '169.254.169.254', family: 4 }])

  await expect(run({ url: 'https://metadata.example.com/latest' })).rejects.toMatchObject({
    name: 'AgentToolError',
    code: 'invalid_params',
  })
})

it('不是网页的内容说清它是什么，并指向取图工具', async () => {
  serve('\u0089PNG binary', 'image/png')

  await expect(run({ url: 'https://shop.example.com/hero.png' })).rejects.toMatchObject({
    name: 'AgentToolError',
    code: 'invalid_params',
    message: expect.stringContaining('取图工具'),
  })
})

it('JSON 缩进后交回', async () => {
  serve('{"name":"chair","price":420}', 'application/json')

  const { text } = await run({ url: 'https://shop.example.com/api/chair' })

  expect(text).toBe('{\n  "name": "chair",\n  "price": 420\n}')
})

it('正文太长时截断并说明，focus 命中处决定保留哪一段', async () => {
  const head = '开头这一句只出现在文章最前面。'
  const marker = '限量版胡桃木款'
  const page = `${head}${'边角料。'.repeat(6_000)}${marker}${'后文。'.repeat(6_000)}`
  serve(page, 'text/plain; charset=utf-8')

  const focused = await run({ url: 'https://shop.example.com/long', focus: marker })
  const plain = await run({ url: 'https://shop.example.com/long' })

  expect(page.length).toBeGreaterThan(15_000)
  // 命中点在正文中段：窗口挪过去了，开头那一句被留在窗口外。
  expect(focused.text).toContain(marker)
  expect(focused.text).toContain(`以上是包含「${marker}」的那一段`)
  expect(focused.text).not.toContain(head)
  // 没给 focus 就从头读，并说清后面还有。
  expect(plain.text.startsWith(head)).toBe(true)
  expect(plain.text).toContain('以上是开头部分，后面还有')
  expect(plain.text).not.toContain(marker)
})
