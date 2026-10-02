import { afterAll, beforeAll, expect, it, vi } from 'vitest'

type Saved = { target: object; name: string; descriptor: PropertyDescriptor | undefined }
const saved: Saved[] = []

function remove(target: object, name: string) {
  saved.push({ target, name, descriptor: Object.getOwnPropertyDescriptor(target, name) })
  delete (target as Record<string, unknown>)[name]
}

beforeAll(async () => {
  // 模拟旧内核：把这些原生 API 拿掉，再执行补丁模块。
  remove(Object, 'hasOwn')
  remove(Array.prototype, 'at')
  remove(String.prototype, 'at')
  remove(Uint8Array.prototype, 'at')
  remove(Array.prototype, 'toSorted')
  remove(AbortSignal, 'timeout')
  remove(AbortSignal, 'any')
  remove(globalThis, 'structuredClone')
  remove(crypto, 'randomUUID')
  vi.resetModules()
  await import('../../boot/polyfills')
})

afterAll(() => {
  for (const { target, name, descriptor } of saved.reverse()) {
    delete (target as Record<string, unknown>)[name]
    if (descriptor) Object.defineProperty(target, name, descriptor)
  }
})

// 测试工程的 lib 比这些 API 旧，按「补上之后的形状」取用。
type At = { at(index: number): unknown }
const hasOwn = (object: object, key: PropertyKey) =>
  (Object as unknown as { hasOwn(o: object, k: PropertyKey): boolean }).hasOwn(object, key)

it('fills the array, string and object helpers', () => {
  expect(hasOwn({ a: 1 }, 'a')).toBe(true)
  expect(hasOwn({ a: 1 }, 'toString')).toBe(false)
  expect(([1, 2, 3] as unknown as At).at(-1)).toBe(3)
  expect(([1, 2, 3] as unknown as At).at(5)).toBeUndefined()
  expect(('abc' as unknown as At).at(0)).toBe('a')
  expect((new Uint8Array([7, 8]) as unknown as At).at(-2)).toBe(7)
  const source = [3, 1, 2]
  expect((source as unknown as { toSorted(): number[] }).toSorted()).toEqual([1, 2, 3])
  expect(source).toEqual([3, 1, 2])
})

it('produces RFC 4122 v4 ids', () => {
  expect(crypto.randomUUID()).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
})

it('combines and times out abort signals', async () => {
  vi.useFakeTimers()
  try {
    const timed = AbortSignal.timeout(100)
    expect(timed.aborted).toBe(false)
    vi.advanceTimersByTime(100)
    expect(timed.aborted).toBe(true)
    expect((timed.reason as DOMException).name).toBe('TimeoutError')
  } finally {
    vi.useRealTimers()
  }
  const first = new AbortController()
  const second = new AbortController()
  const combined = AbortSignal.any([first.signal, second.signal])
  second.abort('stop')
  expect(combined.aborted).toBe(true)
  expect(combined.reason).toBe('stop')
  const already = new AbortController()
  already.abort('early')
  expect(AbortSignal.any([already.signal]).reason).toBe('early')
})

it('deep-clones plain data without sharing references', () => {
  const blob = new Blob(['x'])
  const original = {
    list: [{ id: 1 }],
    when: new Date(5),
    map: new Map([['k', { v: 1 }]]),
    set: new Set([1]),
    bytes: new Uint8Array([1, 2]),
    blob,
  }
  const copy = structuredClone(original)
  expect(copy).toEqual(original)
  expect(copy.list[0]).not.toBe(original.list[0])
  expect(copy.map.get('k')).not.toBe(original.map.get('k'))
  expect(copy.when).not.toBe(original.when)
  expect(copy.bytes).not.toBe(original.bytes)
  expect(copy.blob).toBe(blob)
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  const cyclicCopy = structuredClone(cyclic) as { self: unknown }
  expect(cyclicCopy.self).toBe(cyclicCopy)
})
