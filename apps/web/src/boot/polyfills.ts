/**
 * 旧内核缺的运行时 API。构建目标降到了 Chromium 80 / Safari 14（见 vite.config.ts），
 * 语法由构建降级，这几个 API 只能在这里补；入口第一行导入，排在任何业务模块之前执行。
 *
 * 只补构建产物里真正用到的：新增一个现代 API 时，构建后扫一遍产物再决定要不要加在这里。
 * 每项都先判断原生是否存在，新浏览器上什么都不做。
 */

function define<T extends object>(target: T, name: string, value: unknown): void {
  if (name in target) return
  Object.defineProperty(target, name, { value, writable: true, configurable: true })
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
define(Array.prototype, 'toSorted', function toSorted<T>(
  this: T[],
  compare?: (a: T, b: T) => number,
): T[] {
  return Array.prototype.slice.call(this).sort(compare)
})

// Chrome 92 / Safari 15.4；只在安全上下文里有 crypto.getRandomValues 可用时补。
if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
  define(crypto, 'randomUUID', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  })
}

// Chrome 103 / Safari 16
define(AbortSignal, 'timeout', (milliseconds: number) => {
  const controller = new AbortController()
  setTimeout(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    milliseconds,
  )
  return controller.signal
})

// Chrome 116 / Safari 17.4
define(AbortSignal, 'any', (signals: Iterable<AbortSignal>) => {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
})

// Chrome 98 / Safari 15.4。本应用只克隆纯数据（对象、数组、日期、Map/Set、二进制），
// Blob/File 本身不可变，按引用保留即可。
function clone(value: unknown, seen: Map<unknown, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value
  const known = seen.get(value)
  if (known !== undefined) return known
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof RegExp) return new RegExp(value.source, value.flags)
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value
  if (value instanceof ArrayBuffer) return value.slice(0)
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { slice(): unknown }
    return typeof view.slice === 'function' ? view.slice() : value
  }
  if (value instanceof Map) {
    const copy = new Map()
    seen.set(value, copy)
    for (const [key, item] of value) copy.set(clone(key, seen), clone(item, seen))
    return copy
  }
  if (value instanceof Set) {
    const copy = new Set()
    seen.set(value, copy)
    for (const item of value) copy.add(clone(item, seen))
    return copy
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const item of value) copy.push(clone(item, seen))
    return copy
  }
  const copy: Record<string, unknown> = {}
  seen.set(value, copy)
  for (const key of Object.keys(value)) {
    copy[key] = clone((value as Record<string, unknown>)[key], seen)
  }
  return copy
}
define(globalThis, 'structuredClone', (value: unknown) => clone(value, new Map()))

export {}
