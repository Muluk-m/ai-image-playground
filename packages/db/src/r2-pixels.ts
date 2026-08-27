import type { NewPixelObject, PixelKind, PixelObject, PixelStore } from './stores'

export const PIXEL_KEY_PREFIX = 'image-playground/'

export function pixelObjectKey(taskId: string, kind: PixelKind, idx: number): string {
  return `${PIXEL_KEY_PREFIX}${taskId}/${kind}/${idx}`
}

export interface ObjectBucket {
  put(key: string, data: Buffer, mime: string): Promise<void>
  get(key: string): Promise<{ mime: string; data: Buffer } | undefined>
  list(prefix: string): Promise<string[]>
  delete(key: string): Promise<void>
}

export class MemoryObjectBucket implements ObjectBucket {
  private readonly objects = new Map<string, { mime: string; data: Buffer; createdAt: number }>()

  async put(key: string, data: Buffer, mime: string): Promise<void> {
    this.objects.set(key, { mime, data, createdAt: Date.now() })
  }

  async get(key: string): Promise<{ mime: string; data: Buffer } | undefined> {
    const row = this.objects.get(key)
    return row ? { mime: row.mime, data: row.data } : undefined
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix))
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
}

export function createR2ObjectBucket(env: {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}): ObjectBucket {
  const s3 = new Bun.S3Client({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    bucket: env.bucket,
    endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
  })
  return {
    async put(key, data, mime) {
      await s3.write(key, data, { type: mime })
    },
    async get(key) {
      const file = s3.file(key)
      if (!(await file.exists())) return undefined
      return {
        mime: file.type || 'application/octet-stream',
        data: Buffer.from(await file.arrayBuffer()),
      }
    },
    async list(prefix) {
      const result = await s3.list({ prefix })
      return (result.contents ?? [])
        .map((entry) => entry.key)
        .filter((key): key is string => Boolean(key))
    },
    async delete(key) {
      await s3.delete(key)
    },
  }
}

export class ObjectPixelStore implements PixelStore {
  constructor(private readonly bucket: ObjectBucket) {}

  async putMany(taskId: string, pixels: readonly NewPixelObject[]): Promise<void> {
    await Promise.all(
      pixels.map((pixel) =>
        this.bucket.put(pixelObjectKey(taskId, pixel.kind, pixel.idx), pixel.data, pixel.mime),
      ),
    )
  }

  async get(taskId: string, kind: PixelKind, idx: number): Promise<PixelObject | undefined> {
    const object = await this.bucket.get(pixelObjectKey(taskId, kind, idx))
    if (!object) return undefined
    return {
      taskId,
      kind,
      idx,
      mime: object.mime,
      data: object.data,
      createdAt: 0,
    }
  }

  async list(taskId: string, kind: PixelKind): Promise<PixelObject[]> {
    const prefix = `${PIXEL_KEY_PREFIX}${taskId}/${kind}/`
    const keys = await this.bucket.list(prefix)
    const pixels: PixelObject[] = []
    for (const key of keys) {
      const idx = Number(key.slice(prefix.length))
      if (!Number.isInteger(idx)) continue
      const object = await this.bucket.get(key)
      if (!object) continue
      pixels.push({
        taskId,
        kind,
        idx,
        mime: object.mime,
        data: object.data,
        createdAt: 0,
      })
    }
    return pixels.sort((a, b) => a.idx - b.idx)
  }

  async replaceBytes(
    taskId: string,
    kind: PixelKind,
    idx: number,
    mime: string,
    data: Buffer,
  ): Promise<void> {
    await this.bucket.put(pixelObjectKey(taskId, kind, idx), data, mime)
  }

  async deleteOutputsOlderThan(_cutoff: number): Promise<number> {
    return 0
  }
}
