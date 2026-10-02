import { afterAll, beforeAll, expect, it, vi } from 'vitest'

type Saved = { target: object; name: string; descriptor: PropertyDescriptor | undefined }
const saved: Saved[] = []

function remove(target: object, name: string) {
  saved.push({ target, name, descriptor: Object.getOwnPropertyDescriptor(target, name) })
  delete (target as Record<string, unknown>)[name]
}

function replace(target: object, name: string, value: unknown) {
  saved.push({ target, name, descriptor: Object.getOwnPropertyDescriptor(target, name) })
  Object.defineProperty(target, name, { value, writable: true, configurable: true })
}

beforeAll(async () => {
  // 模拟 Chromium 80：这些 API 不存在，abort() 也会丢掉 reason。
  remove(Object, 'hasOwn')
  remove(Array.prototype, 'at')
  remove(String.prototype, 'at')
  remove(Uint8Array.prototype, 'at')
  remove(Array.prototype, 'toSorted')
  remove(AbortSignal, 'timeout')
  remove(AbortSignal, 'any')
  remove(AbortSignal.prototype, 'reason')
  remove(AbortSignal.prototype, 'throwIfAborted')
  const nativeAbort = AbortController.prototype.abort
  replace(AbortController.prototype, 'abort', function abort(this: AbortController) {
    nativeAbort.call(this)
  })
  remove(globalThis, 'structuredClone')
  remove(globalThis, 'WeakRef')
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
type Signal = AbortSignal & { reason: unknown; throwIfAborted(): void }
const statics = AbortSignal as unknown as {
  timeout(ms: number): Signal
  any(signals: AbortSignal[]): Signal
}
const hasOwn = (object: object, key: PropertyKey) =>
  (Object as unknown as { hasOwn(o: object, k: PropertyKey): boolean }).hasOwn(object, key)
const clone = <T>(value: T): T =>
  (globalThis as unknown as { structuredClone<V>(v: V): V }).structuredClone(value)

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

it('falls back to a strong reference for WeakRef', () => {
  const target = {}
  const WeakRefCtor = (globalThis as unknown as { WeakRef: new (t: object) => { deref(): object } })
    .WeakRef
  expect(new WeakRefCtor(target).deref()).toBe(target)
})

it('keeps the abort reason and throws it on demand', () => {
  const controller = new AbortController()
  const signal = controller.signal as Signal
  expect(signal.reason).toBeUndefined()
  expect(() => signal.throwIfAborted()).not.toThrow()
  const cause = new Error('cancelled by user')
  controller.abort(cause)
  expect(signal.reason).toBe(cause)
  expect(() => signal.throwIfAborted()).toThrow(cause)

  const bare = new AbortController()
  bare.abort()
  expect(((bare.signal as Signal).reason as DOMException).name).toBe('AbortError')
})

it('times out with a TimeoutError reason', () => {
  vi.useFakeTimers()
  try {
    const timed = statics.timeout(100)
    expect(timed.aborted).toBe(false)
    vi.advanceTimersByTime(100)
    expect(timed.aborted).toBe(true)
    expect((timed.reason as DOMException).name).toBe('TimeoutError')
  } finally {
    vi.useRealTimers()
  }
})

it('combines signals and releases every source listener once fired', () => {
  const first = new AbortController()
  const second = new AbortController()
  const removed = vi.spyOn(first.signal, 'removeEventListener')
  const combined = statics.any([first.signal, second.signal])
  second.abort('stop')
  expect(combined.aborted).toBe(true)
  expect(combined.reason).toBe('stop')
  // 长寿的那个信号上的监听也被摘掉了。
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))

  const already = new AbortController()
  already.abort('early')
  const live = new AbortController()
  const listen = vi.spyOn(live.signal, 'addEventListener')
  expect(statics.any([live.signal, already.signal]).reason).toBe('early')
  expect(listen).not.toHaveBeenCalled()
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
  const copy = clone(original)
  expect(copy).toEqual(original)
  expect(copy.list[0]).not.toBe(original.list[0])
  expect(copy.map.get('k')).not.toBe(original.map.get('k'))
  expect(copy.when).not.toBe(original.when)
  expect(copy.bytes).not.toBe(original.bytes)
  expect(copy.blob).toBe(blob)
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  const cyclicCopy = clone(cyclic) as { self: unknown }
  expect(cyclicCopy.self).toBe(cyclicCopy)
})

it('keeps repeated references and shared buffers shared, and DataView detached', () => {
  const buffer = new ArrayBuffer(4)
  const when = new Date(1)
  const source = {
    a: buffer,
    b: buffer,
    first: new Uint8Array(buffer, 0, 2),
    second: new Uint8Array(buffer, 2, 2),
    view: new DataView(buffer, 1, 2),
    when,
    again: when,
  }
  const copy = clone(source)
  expect(copy.a).toBe(copy.b)
  expect(copy.a).not.toBe(buffer)
  expect(copy.again).toBe(copy.when)
  expect(copy.first.buffer).toBe(copy.a)
  expect(copy.second.buffer).toBe(copy.a)
  expect(copy.view.buffer).toBe(copy.a)
  expect([copy.view.byteOffset, copy.view.byteLength]).toEqual([1, 2])
  copy.view.setUint8(0, 9)
  expect(new Uint8Array(buffer)[1]).toBe(0)
  expect(copy.first[1]).toBe(9)
})

it('copies an own __proto__ key as data without touching the prototype', () => {
  const parsed = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>
  const copy = clone(parsed)
  expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
  expect(Object.keys(copy)).toEqual(['__proto__'])
  expect((copy as { x?: unknown }).x).toBeUndefined()
})

it('keeps an explicit null abort reason and a stable default reason', () => {
  const controller = new AbortController()
  controller.abort(null)
  const signal = controller.signal as Signal
  expect(signal.reason).toBeNull()
  expect(() => signal.throwIfAborted()).toThrow()
  expect(statics.any([signal]).reason).toBeNull()

  const bare = new AbortController()
  bare.abort()
  expect((bare.signal as Signal).reason).toBe((bare.signal as Signal).reason)
})

it('keeps array length across holes', () => {
  const trailing = [1, , ,]
  expect(clone(new Array(3)).length).toBe(3)
  expect(clone(trailing).length).toBe(3)
  expect(clone(trailing)[0]).toBe(1)
})
