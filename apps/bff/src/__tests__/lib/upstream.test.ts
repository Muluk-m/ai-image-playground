import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

// 注入测试环境变量，必须早于 config import。
// DATABASE_URL 跟 routes.test.ts 用同一路径——config 是模块顶层捕获，
// 测试间共享 process，路径不一致会让 routes.test.ts 的 db client 指错文件。
process.env.SUB2API_BASE_URL = 'http://localhost:9999'
process.env.SUB2API_API_KEY = 'test-key'
process.env.DATABASE_URL = './artifacts/test-routes.sqlite'
process.env.PORT = '0'

const { callUpstream } = await import('../../lib/upstream')

// 1x1 透明 PNG 的 base64
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`

type FetchCall = { url: string; init: RequestInit | undefined }

describe('callUpstream OpenAI route', () => {
  const originalFetch = globalThis.fetch
  let calls: FetchCall[] = []

  beforeEach(() => {
    calls = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
      return new Response(JSON.stringify({ data: [{ b64_json: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('without input_images: hits /v1/images/generations with JSON body', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'a cat', size: '1024x1024' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/images\/generations$/)
    const body = calls[0]!.init?.body
    expect(typeof body).toBe('string')
    const parsed = JSON.parse(body as string)
    expect(parsed).toMatchObject({ model: 'gpt-image-2', prompt: 'a cat', size: '1024x1024' })
  })

  it('with input_images: hits /v1/images/edits with multipart FormData containing image[]', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'turn this cat into a dog',
        size: '1024x1024',
        input_images: [TINY_PNG_DATA_URL],
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const body = calls[0]!.init?.body
    // multipart FormData，不是 JSON
    expect(body).toBeInstanceOf(FormData)
    const form = body as FormData
    expect(form.get('model')).toBe('gpt-image-2')
    expect(form.get('prompt')).toBe('turn this cat into a dog')
    expect(form.get('size')).toBe('1024x1024')
    // image[] 必须以 Blob/File 形式存在，且字节数 > 0
    const images = form.getAll('image[]')
    expect(images).toHaveLength(1)
    const file = images[0]
    expect(file).toBeInstanceOf(Blob)
    expect((file as Blob).size).toBeGreaterThan(0)
  })

  it('with multiple input_images: appends one image[] entry per data URL', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'merge these',
        input_images: [TINY_PNG_DATA_URL, TINY_PNG_DATA_URL, TINY_PNG_DATA_URL],
      },
    })
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as FormData
    expect(form.getAll('image[]')).toHaveLength(3)
  })

  it('with input_images and n>1: forwards n via FormData field', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'edit',
        n: 3,
        input_images: [TINY_PNG_DATA_URL],
      },
    })
    const form = calls[0]!.init?.body as FormData
    expect(form.get('n')).toBe('3')
  })

  it('with mask: appends mask Blob alongside image[] in FormData', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'mask edit',
        input_images: [TINY_PNG_DATA_URL],
        mask: TINY_PNG_DATA_URL,
      },
    })
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as FormData
    expect(form.getAll('image[]')).toHaveLength(1)
    const mask = form.get('mask')
    expect(mask).toBeInstanceOf(Blob)
    expect((mask as Blob).size).toBeGreaterThan(0)
  })

  it('with mask but no input_images: still hits /v1/images/edits', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'edit', mask: TINY_PNG_DATA_URL },
    })
    expect(calls[0]!.url).toMatch(/\/v1\/images\/edits$/)
    const form = calls[0]!.init?.body as FormData
    expect(form.get('mask')).toBeInstanceOf(Blob)
  })

  it('preserves Bearer authorization header on edits path', async () => {
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'edit', input_images: [TINY_PNG_DATA_URL] },
    })
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-key')
    // multipart Content-Type 必须由 fetch / FormData 自己生成（含 boundary），不能手填 application/json
    const ct = headers.get('content-type')
    expect(ct === null || ct.startsWith('multipart/form-data')).toBe(true)
  })
})
