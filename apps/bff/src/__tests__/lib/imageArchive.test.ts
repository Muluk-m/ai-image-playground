import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused'
process.env.PORT ||= '0'

const { archiveOutputImages, ObjectStorageError, SourceImageFetchError } = await import(
  '../../lib/imageArchive'
)
const { isRetryableError } = await import('../../lib/retry')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { InMemoryObjectStore } = await import('../helpers/inMemoryObjectStore')
const { forbidGlobalFetch, stubGlobalFetch } = await import('../helpers/upstreamStubs')

/** 8x8 纯色 JPEG，用来验证归档按魔数判定 mime 而不是信上游自报的字段。 */
const JPEG_8X8_BASE64 =
  '/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQBsmf/2Q=='

let store: InstanceType<typeof InMemoryObjectStore>
let restoreFetch: () => void

beforeEach(() => {
  store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
  restoreFetch = forbidGlobalFetch()
})

afterEach(() => {
  setObjectStoreForTesting()
  restoreFetch()
})

describe('archiveOutputImages openai-compat', () => {
  it('Grok 的 { b64_json, mime_type } 结果直接落库，不回源取图', async () => {
    const jpeg = Buffer.from(JPEG_8X8_BASE64, 'base64')
    const payload = { data: [{ b64_json: JPEG_8X8_BASE64, mime_type: 'image/jpeg' }] }

    const archived = (await archiveOutputImages('task-grok', 'openai-compat', payload)) as {
      data: Array<Record<string, unknown>>
    }

    const item = archived.data[0]!
    expect(item.object).toBe('task-grok/out/0')
    // mime 由字节魔数判定，不信上游自报的 mime_type。
    expect(item.mime).toBe('image/jpeg')
    expect(item.b64_json).toBeUndefined()
    const stored = store.objects.get('task-grok/out/0')!
    expect(stored.contentType).toBe('image/jpeg')
    expect(Buffer.from(stored.bytes).equals(jpeg)).toBe(true)
  })
})

describe('archiveOutputImages 回源取图', () => {
  const urlPayload = () => ({ data: [{ url: 'https://imgen.example/a.png' }] })

  it('源站非 2xx 归 SourceImageFetchError，判为可重试', async () => {
    restoreFetch()
    restoreFetch = stubGlobalFetch(() => new Response('forbidden', { status: 403 }))

    const error = await archiveOutputImages('task-403', 'openai-compat', urlPayload()).catch(
      (e) => e,
    )

    expect(error).toBeInstanceOf(SourceImageFetchError)
    expect(error.message).toContain('source image HTTP 403')
    expect(isRetryableError(error)).toBe(true)
  })

  it('回源 fetch 抛网络错也归 SourceImageFetchError', async () => {
    restoreFetch()
    restoreFetch = stubGlobalFetch(() => {
      throw new TypeError('Failed to fetch')
    })

    const error = await archiveOutputImages('task-net', 'openai-compat', urlPayload()).catch(
      (e) => e,
    )

    expect(error).toBeInstanceOf(SourceImageFetchError)
    expect(isRetryableError(error)).toBe(true)
  })

  it('对象存储写入失败仍是不可重试的 ObjectStorageError', async () => {
    store.writeFailuresRemaining = 10

    const error = await archiveOutputImages('task-write', 'openai-compat', {
      data: [{ b64_json: JPEG_8X8_BASE64 }],
    }).catch((e) => e)

    expect(error).toBeInstanceOf(ObjectStorageError)
    expect(error).not.toBeInstanceOf(SourceImageFetchError)
    expect(isRetryableError(error)).toBe(false)
  })
})
