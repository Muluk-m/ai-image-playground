import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused'
process.env.PORT ||= '0'

const { durableGenerationInputs } = await import('../../lib/generationMedia')
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
