import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import sharp from 'sharp'

// config 在模块初始化时读环境；这里不碰数据库，只是让它能构造出来。
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.PORT = '0'

const { archiveOutputImages } = await import('../../lib/imageArchive')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
type ObjectStore = import('../../lib/objectStore').ObjectStore

class FakeObjectStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; mime: string }>()

  async write(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes: Uint8Array.from(bytes), mime: contentType })
  }

  async read(key: string): Promise<Uint8Array<ArrayBuffer>> {
    const stored = this.objects.get(key)
    if (!stored) throw new Error(`missing object: ${key}`)
    return Uint8Array.from(stored.bytes) as Uint8Array<ArrayBuffer>
  }

  async listPrefix(prefix: string): Promise<string[]> {
    return Array.from(this.objects.keys()).filter((key) => key.startsWith(prefix))
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of await this.listPrefix(prefix)) this.objects.delete(key)
  }
}

describe('archiveOutputImages openai-compat', () => {
  let store: FakeObjectStore

  beforeEach(() => {
    store = new FakeObjectStore()
    setObjectStoreForTesting(store)
  })

  afterEach(() => {
    setObjectStoreForTesting()
  })

  it('Grok 的 { b64_json, mime_type } 结果落库，不发起任何网络取图', async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#cc5500' },
    })
      .jpeg()
      .toBuffer()
    const payload = {
      data: [{ b64_json: jpeg.toString('base64'), mime_type: 'image/jpeg' }],
    }

    const archived = (await archiveOutputImages('task-grok', 'openai-compat', payload)) as {
      data: Array<Record<string, unknown>>
    }

    const item = archived.data[0]!
    expect(item.object).toBe('task-grok/out/0')
    // mime 由字节魔数判定，不信上游自报的 mime_type。
    expect(item.mime).toBe('image/jpeg')
    expect(item.b64_json).toBeUndefined()
    expect(item.source_url).toBeUndefined()
    const stored = store.objects.get('task-grok/out/0')!
    expect(stored.mime).toBe('image/jpeg')
    expect(Buffer.from(stored.bytes).equals(jpeg)).toBe(true)
  })
})
