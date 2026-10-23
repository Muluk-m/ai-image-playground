import { describe, expect, it, spyOn } from 'bun:test'
import { normalizeKeyPrefix } from '../../lib/objectKeyPrefix'
import { stubGlobalFetch } from '../helpers/upstreamStubs'

process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:5432/unused'
const { createDurableMediaStore } = await import('../../lib/durableMediaStore')
const { ObjectStoreHttpError, readObjectWithinLimit, S3ObjectStore } = await import(
  '../../lib/objectStore'
)
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

  /** 设置后，所有范围读都抛这个错误，模拟网络或上游故障。 */
  rangeFailure: Error | undefined

  file(key: string, span?: { begin: number; end: number }) {
    const bytes = () => {
      const stored = this.objects.get(key)
      if (!stored) throw new Error(`missing object: ${key}`)
      if (span && this.rangeFailure) throw this.rangeFailure
      // 和 S3/R2 一样：起点不落在对象内的 Range 请求（含零字节对象上的 bytes=0-n）返回 416，
      // Bun 把它抛成 code 为 InvalidRange 的 S3Error。
      if (span && span.begin >= stored.length)
        throw Object.assign(new Error('The requested range is not satisfiable'), {
          name: 'S3Error',
          code: 'InvalidRange',
        })
      return span ? stored.slice(span.begin, span.end) : stored.slice()
    }
    return {
      presign: (options: { expiresIn?: number; method?: string }) => this.presign(key, options),
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
  it('uses cancellable signed HEAD metadata without starting an uncancellable stat', async () => {
    const client = new FakeS3Client()
    const subject = store(client, 'paid/')
    const controller = new AbortController()
    const transport = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { headers: { 'content-length': '12' } }),
    )
    try {
      expect((await subject.open('agent/c/cache.json', controller.signal)).size).toBe(12)
      expect(transport.mock.calls[0]?.[0]).toContain(
        'paid/agent/c/cache.json?expiresIn=60&method=HEAD',
      )
      expect(transport.mock.calls[0]?.[1]).toMatchObject({
        method: 'HEAD',
        signal: controller.signal,
      })
      expect(client.statted).toHaveLength(0)
      transport.mockResolvedValueOnce(new Response(null))
      await expect(subject.open('missing-size', controller.signal)).rejects.toThrow(
        'Invalid object size',
      )
      transport.mockImplementation(
        Object.assign(
          (_url: RequestInfo | URL, options?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                once: true,
              })
            }),
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      const waiting = subject.open('stalled', controller.signal)
      controller.abort(new Error('deadline'))
      await expect(waiting).rejects.toThrow('deadline')
      await expect(subject.open('preaborted', controller.signal)).rejects.toThrow('deadline')
      expect(transport).toHaveBeenCalledTimes(3)
    } finally {
      transport.mockRestore()
    }
  })

  it('reads a deadline-bound object through a cancellable signed range request', async () => {
    const subject = store(new FakeS3Client(), 'paid/')
    const controller = new AbortController()
    const transport = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { headers: { 'content-length': '2' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 8]), { status: 206 }))
    try {
      expect(
        await readObjectWithinLimit(subject, 'agent/c/cache.json', 8, controller.signal),
      ).toEqual(new Uint8Array([7, 8]))
      expect(transport.mock.calls[1]?.[0]).toContain(
        'paid/agent/c/cache.json?expiresIn=60&method=GET',
      )
      expect(transport.mock.calls[1]?.[1]).toMatchObject({
        headers: { range: 'bytes=0-1' },
        signal: controller.signal,
      })
    } finally {
      transport.mockRestore()
    }
  })

  it('带期限的整份读取走同一客户端签名的 GET：可取消，非 2xx 带上状态码', async () => {
    const client = new FakeS3Client()
    client.objects.set('paid/objects/u/m/original', new Uint8Array([9]))
    const subject = store(client, 'paid/')
    const controller = new AbortController()
    const transport = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3])),
    )
    try {
      expect(await subject.read('objects/u/m/original', controller.signal)).toEqual(
        new Uint8Array([1, 2, 3]),
      )
      expect(transport.mock.calls[0]?.[0]).toContain(
        'paid/objects/u/m/original?expiresIn=60&method=GET',
      )
      expect(transport.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal })

      transport.mockResolvedValueOnce(new Response('InternalError', { status: 500 }))
      const failed = await subject.read('objects/u/m/original', controller.signal).catch((e) => e)
      expect(failed).toBeInstanceOf(ObjectStoreHttpError)
      expect(failed.status).toBe(500)

      transport.mockImplementation(
        Object.assign(
          (_url: RequestInfo | URL, options?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                once: true,
              })
            }),
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      const waiting = subject.read('objects/u/m/original', controller.signal)
      controller.abort(new Error('deadline'))
      await expect(waiting).rejects.toThrow('deadline')
      // 不给信号时仍走原来的客户端读取。
      expect(await subject.read('objects/u/m/original')).toEqual(new Uint8Array([9]))
    } finally {
      transport.mockRestore()
    }
  })

  it('uploads cancellable cache writes using a signed PUT with the same prefix and content type', async () => {
    const subject = store(new FakeS3Client(), 'paid/')
    const controller = new AbortController()
    const transport = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    )
    try {
      await subject.write(
        'agent/c/model-context-v1.json',
        new TextEncoder().encode('{}'),
        'application/json',
        controller.signal,
      )
      expect(transport.mock.calls[0]?.[0]).toBe(
        'https://r2.example.test/paid/agent/c/model-context-v1.json?expiresIn=60&method=PUT',
      )
      expect(transport.mock.calls[0]?.[1]).toMatchObject({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
      })
      transport.mockResolvedValue(new Response(null, { status: 503 }))
      await expect(
        subject.write('cache', new Uint8Array(), 'application/json', controller.signal),
      ).rejects.toThrow('Object upload failed (503)')
      controller.abort(new Error('deadline'))
      await expect(
        subject.write('cache', new Uint8Array(), 'application/json', controller.signal),
      ).rejects.toThrow('deadline')
      expect(transport).toHaveBeenCalledTimes(2)
    } finally {
      transport.mockRestore()
    }
  })

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

  it('readUpTo 不先查大小，一次范围读至多取 maxBytes 字节', async () => {
    const client = new FakeS3Client()
    const subject = store(client, 'image-playground/')
    await subject.write('staging/a', new Uint8Array([1, 2, 3, 4, 5]), 'image/png')

    // 核对「恰好 4 字节」时传 5：对象多出来的字节能被看出来，但不会多读。
    expect(await subject.readUpTo('staging/a', 5)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(await subject.readUpTo('staging/a', 3)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await subject.readUpTo('staging/a', 9)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(client.statted).toHaveLength(0)
  })

  it('readUpTo 读零字节对象返回空，交给调用方判大小不符；对象缺失仍报错', async () => {
    const client = new FakeS3Client()
    const subject = store(client, 'image-playground/')
    await subject.write('staging/empty', new Uint8Array(), 'image/png')

    expect(await subject.readUpTo('staging/empty', 5)).toEqual(new Uint8Array())
    await expect(subject.readUpTo('staging/missing', 5)).rejects.toThrow('missing object')
  })

  it('readUpTo 只把 416 当成零字节对象，其他读取故障即使对象为空也原样抛出', async () => {
    const client = new FakeS3Client()
    const subject = store(client, 'image-playground/')
    await subject.write('staging/empty', new Uint8Array(), 'image/png')
    client.rangeFailure = Object.assign(new Error('boom'), {
      name: 'S3Error',
      code: 'InternalError',
    })

    await expect(subject.readUpTo('staging/empty', 5)).rejects.toThrow('boom')
    expect(client.statted).toHaveLength(0)
  })

  it('collectUpTo 收满上限就停止读取上游，多给的分块不进缓冲', async () => {
    const { collectUpTo } = await import('../../lib/objectStore')
    let pulled = 0
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])]
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const next = chunks[pulled++]
          if (next) controller.enqueue(next)
          else controller.close()
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )

    expect(await collectUpTo(stream, 3)).toEqual(new Uint8Array([1, 2, 3]))
    expect(pulled).toBe(2)
    expect(cancelled).toBe(true)
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

it('cancels a streamed PUT even after the destination has consumed all input', async () => {
  const client = new FakeS3Client()
  const subject = store(client, 'paid/')
  const controller = new AbortController()
  let consumed!: () => void
  const inputEnded = new Promise<void>((resolve) => {
    consumed = resolve
  })
  let sent: RequestInit | undefined
  const restore = stubGlobalFetch(async (_url, init) => {
    sent = init
    await new Response(init?.body).arrayBuffer()
    consumed()
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
  })
  try {
    const pending = subject.writeStream(
      'video.mp4',
      new Blob(['video']).stream(),
      'video/mp4',
      5,
      controller.signal,
    )
    const rejected = pending.catch((error) => error)
    await inputEnded
    controller.abort(new Error('cancel upload'))
    expect((await rejected).message).toBe('cancel upload')
    expect(sent).toMatchObject({
      method: 'PUT',
      signal: controller.signal,
      headers: { 'content-type': 'video/mp4', 'content-length': '5' },
    })
  } finally {
    restore()
  }
})
