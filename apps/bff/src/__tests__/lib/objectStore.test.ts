import { describe, expect, it } from 'bun:test'
import { normalizeKeyPrefix } from '../../lib/objectKeyPrefix'

process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:5432/unused'
const { createDurableMediaStore } = await import('../../lib/durableMediaStore')
const { S3ObjectStore } = await import('../../lib/objectStore')
type S3ClientLike = import('../../lib/objectStore').S3ClientLike

interface ListCall {
  prefix?: string
  continuationToken?: string
}

class FakeS3Client {
  readonly objects = new Map<string, Uint8Array>()
  readonly listCalls: ListCall[] = []
  readonly deleted: string[] = []
  readonly statted: string[] = []
  pageSize = 1_000
  now = 0
  readonly created = new Map<string, number>()

  presign(key: string, options: { expiresIn?: number; method?: string }) {
    return `https://r2.example.test/${key}?expiresIn=${options.expiresIn}&method=${options.method}`
  }

  expireTemporaryObjects() {
    for (const [key, created] of this.created) {
      if (
        (key.startsWith('image-playground/') || key.startsWith('image-playground-paid/')) &&
        this.now - created >= 45 * 86400000
      )
        this.objects.delete(key)
    }
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, Uint8Array.from(bytes))
    this.created.set(key, this.now)
  }

  file(key: string, span?: { begin: number; end: number }) {
    const bytes = () => {
      const stored = this.objects.get(key)
      if (!stored) throw new Error(`missing object: ${key}`)
      return span ? stored.slice(span.begin, span.end) : stored.slice()
    }
    return {
      arrayBuffer: async () => bytes().buffer,
      stat: async () => {
        this.statted.push(key)
        return { size: bytes().length }
      },
      slice: (begin: number, end: number) => this.file(key, { begin, end }),
      stream: () => new Blob([bytes()]).stream(),
    }
  }

  async list(options: ListCall = {}) {
    this.listCalls.push({ ...options })
    const matching = Array.from(this.objects.keys())
      .filter((key) => key.startsWith(options.prefix ?? ''))
      .sort()
    const start = options.continuationToken ? matching.indexOf(options.continuationToken) : 0
    const page = matching.slice(start, start + this.pageSize)
    const next = matching[start + this.pageSize]
    return {
      contents: page.map((key) => ({ key })),
      isTruncated: next !== undefined,
      nextContinuationToken: next,
    }
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key)
    this.objects.delete(key)
  }
}

function store(client: FakeS3Client, prefix: string) {
  return new S3ObjectStore(client as unknown as S3ClientLike, prefix)
}

describe('S3ObjectStore key prefix', () => {
  it('前缀只加在 bucket 里，调用方的 key 不变', async () => {
    const client = new FakeS3Client()
    const subject = store(client, 'image-playground/')

    await subject.write('task-1/out/0', new Uint8Array([1, 2]), 'image/png')
    expect(Array.from(client.objects.keys())).toEqual(['image-playground/task-1/out/0'])
    expect(await subject.read('task-1/out/0')).toEqual(new Uint8Array([1, 2]))
    expect(await subject.listPrefix('task-1/')).toEqual(['task-1/out/0'])
    expect(client.listCalls[0]?.prefix).toBe('image-playground/task-1/')
  })

  it('open 也走同一套前缀，只取请求的那一段', async () => {
    const client = new FakeS3Client()
    const subject = store(client, 'image-playground/')
    await subject.write('task-1/out/0', new Uint8Array([1, 2, 3, 4, 5]), 'video/mp4')

    const object = await subject.open('task-1/out/0')

    expect(client.statted).toEqual(['image-playground/task-1/out/0'])
    expect(object.size).toBe(5)
    // 闭区间 [1, 3] 要落在 S3File 的开区间 slice(1, 4) 上。
    expect(new Uint8Array(await new Response(object.stream(1, 3)).arrayBuffer())).toEqual(
      new Uint8Array([2, 3, 4]),
    )
  })

  it('空前缀保持原样', async () => {
    const client = new FakeS3Client()
    const subject = store(client, '')

    await subject.write('task-1/out/0', new Uint8Array([3]), 'image/png')
    expect(Array.from(client.objects.keys())).toEqual(['task-1/out/0'])
    expect(await subject.listPrefix('task-1/')).toEqual(['task-1/out/0'])
  })

  it('deletePrefix 删的是带前缀的 key', async () => {
    const client = new FakeS3Client()
    const subject = store(client, 'image-playground/')

    await subject.write('task-1/out/0', new Uint8Array([1]), 'image/png')
    await subject.write('task-2/out/0', new Uint8Array([2]), 'image/png')
    await subject.deletePrefix('task-1/')

    expect(client.deleted).toEqual(['image-playground/task-1/out/0'])
    expect(Array.from(client.objects.keys())).toEqual(['image-playground/task-2/out/0'])
  })

  it('list 分页翻完所有页', async () => {
    const client = new FakeS3Client()
    client.pageSize = 2
    const subject = store(client, 'image-playground/')
    for (let i = 0; i < 5; i++) {
      await subject.write(`task-1/out/${i}`, new Uint8Array([i]), 'image/png')
    }

    expect(await subject.listPrefix('task-1/')).toEqual([
      'task-1/out/0',
      'task-1/out/1',
      'task-1/out/2',
      'task-1/out/3',
      'task-1/out/4',
    ])
    expect(client.listCalls.length).toBe(3)
  })
})

describe('normalizeKeyPrefix', () => {
  it('缺省与空串归一成空前缀', () => {
    expect(normalizeKeyPrefix(undefined)).toBe('')
    expect(normalizeKeyPrefix('   ')).toBe('')
  })

  it('剥掉首尾多余的斜杠，补一个尾斜杠', () => {
    expect(normalizeKeyPrefix('/image-playground//')).toBe('image-playground/')
    expect(normalizeKeyPrefix('image-playground')).toBe('image-playground/')
  })

  it('中间的斜杠原样保留', () => {
    expect(normalizeKeyPrefix('team/image-playground')).toBe('team/image-playground/')
  })
})

describe('S3ObjectStore.listEntries', () => {
  it('returns size and modification time with the deployment prefix stripped from each key', async () => {
    const modified = new Date('2026-09-17T18:00:05Z')
    const client = {
      list: async ({ prefix }: { prefix?: string }) => ({
        contents: [
          { key: `${prefix}2026-09-17.dump`, size: 42, lastModified: modified.toISOString() },
        ],
        isTruncated: false,
      }),
    } as unknown as S3ClientLike
    const store = new S3ObjectStore(client, 'image-playground/')

    expect(await store.listEntries('pg/')).toEqual([
      { key: 'pg/2026-09-17.dump', size: 42, lastModified: modified.getTime() },
    ])
  })
})

it('实际临时前缀的45天过期规则不触及项目原件，授权地址仍指向可读的持久对象', async () => {
  const client = new FakeS3Client()
  const temporary = store(client, 'image-playground-paid/')
  const durable = createDurableMediaStore(
    client as unknown as S3ClientLike & Pick<Bun.S3Client, 'presign'>,
    'image-playground-paid/',
  )
  await temporary.write('task/output.png', new Uint8Array([1]), 'image/png')
  await durable.write('objects/owner/media/original', new Uint8Array([2, 3]), 'image/png')
  client.now = 50 * 86400000
  client.expireTemporaryObjects()
  await expect(temporary.read('task/output.png')).rejects.toThrow('missing object')
  expect(await durable.read('objects/owner/media/original')).toEqual(new Uint8Array([2, 3]))
  const signed = new URL(durable.sign('objects/owner/media/original', 'GET'))
  expect(signed.pathname).toBe('/durable/image-playground-paid/objects/owner/media/original')
  expect(signed.searchParams.get('expiresIn')).toBe('600')
})
