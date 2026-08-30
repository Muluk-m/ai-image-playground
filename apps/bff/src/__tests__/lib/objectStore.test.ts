import { describe, expect, it } from 'bun:test'

process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:5432/unused'
const { S3ObjectStore } = await import('../../lib/objectStore')

interface ListCall {
  prefix?: string
  continuationToken?: string
}

class FakeS3Client {
  readonly objects = new Map<string, Uint8Array>()
  readonly listCalls: ListCall[] = []
  readonly deleted: string[] = []
  pageSize = 1_000

  async write(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, Uint8Array.from(bytes))
  }

  file(key: string) {
    return {
      arrayBuffer: async () => {
        const stored = this.objects.get(key)
        if (!stored) throw new Error(`missing object: ${key}`)
        return stored.slice().buffer
      },
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
  return new S3ObjectStore(client as unknown as Bun.S3Client, prefix)
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
