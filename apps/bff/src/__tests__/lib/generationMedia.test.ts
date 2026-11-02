import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused'
process.env.PORT ||= '0'

const { durableGenerationInputs, generationSourceCheckpoint } = await import(
  '../../lib/generationMedia'
)
const { InputPreservationError } = await import('../../lib/imageArchive')
const { isRetryableError } = await import('../../lib/retry')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { InMemoryObjectStore } = await import('../helpers/inMemoryObjectStore')

const REQUEST = {
  prompt: 'edit',
  input_images: [{ object: 'task/in/0', mime: 'image/png' }],
}

class DurableStorage extends InMemoryObjectStore {
  sign(key: string) {
    return `https://storage.example.test/${key}`
  }
}

let store: InstanceType<typeof InMemoryObjectStore>
let durable: DurableStorage

beforeEach(() => {
  store = new InMemoryObjectStore()
  durable = new DurableStorage()
  setObjectStoreForTesting(store)
  setDurableMediaStoreForTesting(durable)
})

afterEach(() => {
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
})

describe('durableGenerationInputs', () => {
  it('对象存储瞬时失败时抛可重试的存储错误', async () => {
    await store.write('task/in/0', new Uint8Array([1, 2, 3]), 'image/png')
    store.readFailuresRemaining = 1

    const error = await durableGenerationInputs(REQUEST).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(InputPreservationError)
    expect(isRetryableError(error)).toBe(true)
    expect(durable.objects.size).toBe(0)
  })

  it('原件本身不合格时不重试', async () => {
    await store.write('task/in/0', new Uint8Array(), 'image/png')

    const error = await durableGenerationInputs(REQUEST).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(InputPreservationError)
    expect(isRetryableError(error)).toBe(false)
  })
})

describe('generationSourceCheckpoint', () => {
  const B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='

  it('只带校验过的缺口记录，不把上游同名字段原样带进检查点', () => {
    for (const forged of [
      { requested: 2, failed: 1, type: 'rate_limited', note: 'x' },
      { requested: 2, failed: 5, type: 'rate_limited' },
      { requested: '2', failed: 1, type: 'rate_limited' },
      { requested: 2, failed: 1, type: 'model_unavailable' },
      'oops',
    ]) {
      const checkpoint = generationSourceCheckpoint('task', 'openai-compat', {
        data: [{ b64_json: B64 }],
        partial_failure: forged,
      }) as Record<string, unknown>
      const carried = checkpoint.partial_failure
      if (carried !== undefined)
        expect(carried).toEqual({ requested: 2, failed: 1, type: 'rate_limited' })
    }
  })

  it('不合格的缺口记录不进检查点（两条线路都一样）', () => {
    const forged = { requested: 2, failed: 5, type: 'rate_limited' }
    const openai = generationSourceCheckpoint('task', 'openai-compat', {
      data: [{ b64_json: B64 }],
      partial_failure: forged,
    }) as Record<string, unknown>
    expect(openai).not.toHaveProperty('partial_failure')
    const gemini = generationSourceCheckpoint('task', 'gemini', {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] } }],
      partial_failure: forged,
    }) as Record<string, unknown>
    expect(gemini).not.toHaveProperty('partial_failure')
  })

  it('合格的缺口记录照原样带上', () => {
    const record = { requested: 3, failed: 1, type: 'upstream_timeout' }
    const checkpoint = generationSourceCheckpoint('task', 'openai-compat', {
      data: [{ b64_json: B64 }],
      partial_failure: record,
    }) as Record<string, unknown>
    expect(checkpoint.partial_failure).toEqual(record)
  })
})
