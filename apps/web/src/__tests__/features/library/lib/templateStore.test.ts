import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { templateStore } from '../../../../features/library/lib/templateStore'
import type { TemplateRecord } from '../../../../features/library/types'

function makeTemplate(overrides: Partial<TemplateRecord> = {}): TemplateRecord {
  return {
    id: 't1',
    name: '锁产品前缀',
    prompt: '保持⁣@图1⁤的产品不变，背景换成{背景}',
    assetIds: ['a1', null],
    params: { size: '1024x1024', quality: 'high', n: 2 },
    createdAt: 1000,
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
})
