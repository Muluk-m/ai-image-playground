/**
 * 旧内核缺的运行时 API。构建目标降到了 Chromium 80 / Safari 14（见 vite.config.ts），
 * 语法由构建降级，这几个 API 只能在这里补；入口第一行导入，排在任何业务模块之前执行。
 *
 * 只补构建产物里真正用到、又没有自带特性检测的：新增一个现代 API 时，构建后扫一遍产物再决定
 * 要不要加在这里。每项都先判断原生是否存在，新浏览器上什么都不做。
 */

function define<T extends object>(target: T, name: string, value: unknown): void {
  if (name in target) return
  Object.defineProperty(target, name, { value, writable: true, configurable: true })
}

function abortError(): DOMException {
  return new DOMException('signal is aborted without reason', 'AbortError')
}

// Chrome 93 / Safari 15.4
define(Object, 'hasOwn', (object: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(object, key),
)

// Chrome 92 / Safari 15.4
function at<T>(this: ArrayLike<T>, index: number): T | undefined {
  const length = this.length
  const relative = Math.trunc(index) || 0
  const position = relative < 0 ? length + relative : relative
  return position < 0 || position >= length ? undefined : this[position]
}
define(Array.prototype, 'at', at)
define(String.prototype, 'at', at)
for (const typed of [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
]) {
  define(typed.prototype, 'at', at)
}

// Chrome 110 / Safari 16
function toSorted<T>(this: T[], compare?: (a: T, b: T) => number): T[] {
  return Array.prototype.slice.call(this).sort(compare)
}
define(Array.prototype, 'toSorted', toSorted)

// Chrome 92 / Safari 15.4；只在 crypto.getRandomValues 可用时补。
if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
  define(crypto, 'randomUUID', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  })
}

// Chrome 84 / Safari 14.1。旧内核上退化成强引用：图片预览缓存本身有条数上限，不会无界增长。
define(
  globalThis,
  'WeakRef',
  class WeakRefFallback<T extends object> {
    readonly #target: T
    constructor(target: T) {
      this.#target = target
    }
    deref(): T {
      return this.#target
    }
  },
)

// Chrome 98 / Safari 15.4：`abort(reason)` 与 `signal.reason`。旧实现会丢掉 reason，
// 而业务按 `reason.name` 区分超时、按 `signal.reason` 拒绝 Promise，所以先补这一层。
if (!('reason' in AbortSignal.prototype)) {
  const reasons = new WeakMap<AbortSignal, unknown>()
  Object.defineProperty(AbortSignal.prototype, 'reason', {
    configurable: true,
    get(this: AbortSignal) {
      if (!this.aborted) return undefined
      // 用 has 而不是 ??：显式的 `abort(null)` 原因要原样保留。没登记的（被浏览器自身取消）补一个并记住，
      // 每次读到的是同一个对象。
      if (!reasons.has(this)) reasons.set(this, abortError())
      return reasons.get(this)
    },
  })
  const nativeAbort = AbortController.prototype.abort
  AbortController.prototype.abort = function abort(this: AbortController, reason?: unknown) {
    if (!this.signal.aborted) reasons.set(this.signal, reason === undefined ? abortError() : reason)
    nativeAbort.call(this)
  }
}

// Chrome 100 / Safari 15.4
define(AbortSignal.prototype, 'throwIfAborted', function throwIfAborted(this: AbortSignal) {
  if (this.aborted) throw this.reason
})

// Chrome 103 / Safari 16
define(AbortSignal, 'timeout', (milliseconds: number) => {
  const controller = new AbortController()
  setTimeout(
    () => controller.abort(new DOMException('signal timed out', 'TimeoutError')),
    milliseconds,
  )
  return controller.signal
})

// Chrome 116 / Safari 17.4。组合信号一旦触发就摘掉所有源信号上的监听，长寿的业务信号
// 不会因每次请求组合一个超时信号而越挂越多。
define(AbortSignal, 'any', (signals: Iterable<AbortSignal>) => {
  const sources = [...signals]
  const controller = new AbortController()
  const early = sources.find((signal) => signal.aborted)
  if (early) {
    controller.abort(early.reason)
    return controller.signal
  }
  const listeners = sources.map((signal) => {
    const onAbort = () => {
      for (const [source, listener] of listeners) source.removeEventListener('abort', listener)
      controller.abort(signal.reason)
    }
    signal.addEventListener('abort', onAbort)
    return [signal, onAbort] as const
  })
  return controller.signal
})

// Chrome 98 / Safari 15.4。本应用只克隆纯数据：对象、数组、日期、正则、Map/Set、二进制。
// 与原生一致：同一对象的多处引用克隆后仍是同一个；多个视图共享的缓冲区仍然共享；
// Blob/File 不可变，按引用保留。
type TypedArrayConstructor = new (
  buffer: ArrayBuffer,
  byteOffset: number,
  length: number,
) => ArrayBufferView

function clone(value: unknown, seen: Map<unknown, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value
  const remember = <T>(copy: T): T => {
    seen.set(value, copy)
    return copy
  }
  if (value instanceof Date) return remember(new Date(value.getTime()))
  if (value instanceof RegExp) return remember(new RegExp(value.source, value.flags))
  if (value instanceof ArrayBuffer) return remember(value.slice(0))
  if (ArrayBuffer.isView(value)) {
    const buffer = clone(value.buffer, seen) as ArrayBuffer
    if (value instanceof DataView)
      return remember(new DataView(buffer, value.byteOffset, value.byteLength))
    const typed = value as ArrayBufferView & { length: number }
    const Constructor = typed.constructor as TypedArrayConstructor
    return remember(new Constructor(buffer, typed.byteOffset, typed.length))
  }
  if (value instanceof Map) {
    const copy = remember(new Map())
    for (const [key, item] of value) copy.set(clone(key, seen), clone(item, seen))
    return copy
  }
  if (value instanceof Set) {
    const copy = remember(new Set())
    for (const item of value) copy.add(clone(item, seen))
    return copy
  }
  // 数组按原长度建，尾部空槽不会把长度弄丢。
  const copy = remember(Array.isArray(value) ? new Array<unknown>(value.length) : {})
  for (const key of Object.keys(value)) {
    // 用 defineProperty 而不是赋值：自有的 `__proto__` 键要复制成普通数据属性，不能触发原型设置器。
    Object.defineProperty(copy, key, {
      value: clone((value as Record<string, unknown>)[key], seen),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return copy
}
define(globalThis, 'structuredClone', (value: unknown) => clone(value, new Map()))

export {}
