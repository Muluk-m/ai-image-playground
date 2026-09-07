import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { templateStore } from '../../../../features/library/lib/templateStore'
import type { TemplateRecord } from '../../../../features/library/types'
import { dbTransaction, STORE_TEMPLATES } from '../../../../lib/db'

function makeTemplate(overrides: Partial<TemplateRecord> = {}): TemplateRecord {
  return {
    id: 't1',
    name: '锁产品前缀',
    prompt: '保持⁣@图1⁤的产品不变，背景换成{背景}',
    assetIds: ['a1', null],
    params: { size: '1024x1024', quality: 'high', n: 2 },
    createdAt: 1000,
    updatedAt: 1000,
    lastUsedAt: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('template storage', () => {
  it('reads back the marked prompt, the ordered asset ids and the param snapshot', async () => {
    await templateStore.put(makeTemplate())

    expect(await templateStore.list()).toEqual([makeTemplate()])
  })

  it('replaces a record on the same id', async () => {
    await templateStore.put(makeTemplate())
    await templateStore.put(makeTemplate({ name: '改过的名字' }))

    const templates = await templateStore.list()
    expect(templates).toHaveLength(1)
    expect(templates[0].name).toBe('改过的名字')
  })

  it('removes one record', async () => {
    await templateStore.put(makeTemplate({ id: 't1' }))
    await templateStore.put(makeTemplate({ id: 't2' }))

    await templateStore.remove('t1')

    expect((await templateStore.list()).map((template) => template.id)).toEqual(['t2'])
  })

  it('leaves a tombstone behind instead of dropping the row', async () => {
    await templateStore.put(makeTemplate({ id: 't1' }))

    await templateStore.remove('t1')

    const rows = await dbTransaction<Array<Record<string, unknown>>>(
      STORE_TEMPLATES,
      'readonly',
      (store) => store.getAll(),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('t1')
    expect(typeof rows[0].deletedAt).toBe('number')
    expect(rows[0].prompt).toBeUndefined()
  })

  it('hides a tombstone written by another device', async () => {
    await dbTransaction(STORE_TEMPLATES, 'readwrite', (store) =>
      store.put({ id: 't1', updatedAt: 2000, deletedAt: 2000 }),
    )

    expect(await templateStore.list()).toEqual([])
  })
})
