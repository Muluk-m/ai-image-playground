import { afterEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import type { ObjectEntry } from '../../lib/objectStore'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const bffRoot = resolve(import.meta.dir, '../../..')
process.env.PORT = '0'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.OPERATOR_CONFIG_FILE = resolve(bffRoot, 'operator-config.example.json')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { app } = await import('../../app')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

const auth = { authorization: 'Bearer fixture-service-credential-alpha' }
const day = 24 * 3600_000

/** 备份是 pg-backup 容器用 aws cli 直接传上去的，这里按它的 key 规则摆几个对象。 */
class BackupStore extends InMemoryObjectStore {
  constructor(private readonly entries: ObjectEntry[]) {
    super()
  }
  override async listEntries(prefix: string): Promise<ObjectEntry[]> {
    return this.entries.filter((entry) => entry.key.startsWith(prefix))
  }
}

afterEach(() => setObjectStoreForTesting())

async function backups(): Promise<Response> {
  return app.handle(new Request('http://localhost/internal/admin/ops/backups', { headers: auth }))
}

describe('GET /internal/admin/ops/backups', () => {
  it('is closed to callers without the service credential', async () => {
    const response = await app.handle(new Request('http://localhost/internal/admin/ops/backups'))
    expect(response.status).toBe(401)
  })

  it('reports the newest dump actually sitting in the bucket, and the one before it', async () => {
    const now = Date.now()
    setObjectStoreForTesting(
      new BackupStore([
        { key: 'pg/2026-09-15.dump', size: 40_000_000, lastModified: now - 2 * day },
        { key: 'pg/2026-09-17.dump', size: 42_000_000, lastModified: now - 3600_000 },
        { key: 'pg/2026-09-16.dump', size: 41_000_000, lastModified: now - day },
        // 同一个桶里的业务对象不是备份。
        { key: 'tasks/abc/0.png', size: 1, lastModified: now },
      ]),
    )

    const response = await backups()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      latest: { key: 'pg/2026-09-17.dump', size_bytes: 42_000_000, modified_at: now - 3600_000 },
      previous: { key: 'pg/2026-09-16.dump', size_bytes: 41_000_000, modified_at: now - day },
    })
  })

  it('ignores an object the bucket gave no modification time for', async () => {
    const now = Date.now()
    setObjectStoreForTesting(
      new BackupStore([
        { key: 'pg/2026-09-17.dump', size: 42_000_000, lastModified: 0 },
        { key: 'pg/2026-09-16.dump', size: 41_000_000, lastModified: now - day },
      ]),
    )

    const body = (await (await backups()).json()) as { latest: { key: string } | null }
    expect(body.latest?.key).toBe('pg/2026-09-16.dump')
  })

  it('says so plainly when there is no backup yet, rather than failing', async () => {
    setObjectStoreForTesting(new BackupStore([]))
    const response = await backups()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ latest: null, previous: null })
  })
})
