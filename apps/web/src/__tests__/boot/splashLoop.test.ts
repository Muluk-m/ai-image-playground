// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const sourceHtml = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
const bootHtml = sourceHtml.slice(
  sourceHtml.indexOf('<div id="boot"'),
  sourceHtml.indexOf('</div></div>') + '</div></div>'.length,
)
const loopScript = sourceHtml.slice(
  sourceHtml.indexOf('<script id="boot-loop">') + '<script id="boot-loop">'.length,
  sourceHtml.indexOf('</script>', sourceHtml.indexOf('<script id="boot-loop">')),
)

function installMatchMedia(reduce: boolean) {
  const matchMedia = (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })
  vi.stubGlobal('matchMedia', matchMedia)
}

const animationDescriptor = Object.getOwnPropertyDescriptor(
  CSSStyleDeclaration.prototype,
  'animation',
)

function animationWrites(): string[] {
  const writes: string[] = []
  Object.defineProperty(CSSStyleDeclaration.prototype, 'animation', {
    configurable: true,
    enumerable: animationDescriptor?.enumerable ?? true,
    get() {
      return animationDescriptor?.get?.call(this)
    },
    set(value: string) {
      writes.push(value)
      animationDescriptor?.set?.call(this, value)
    },
  })
  return writes
}

beforeEach(() => {
  document.body.innerHTML = bootHtml
  vi.useFakeTimers()
})

afterEach(() => {
  if (animationDescriptor) {
    Object.defineProperty(CSSStyleDeclaration.prototype, 'animation', animationDescriptor)
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it('replays the sprout one second after the last petal finishes', () => {
  installMatchMedia(false)
  const writes = animationWrites()
  window.Function(loopScript)()
  const last = document.querySelector('.petal:last-of-type')
  expect(last).not.toBeNull()
  last?.dispatchEvent(new Event('animationend'))
  vi.advanceTimersByTime(999)
  expect(writes).toEqual([])
  vi.advanceTimersByTime(1)
  // 底板 + 四片花瓣：先取消动画，再交回样式表重播。
  expect(writes).toEqual(['none', 'none', 'none', 'none', 'none', '', '', '', '', ''])
})

it('does not replay once the splash is leaving or motion is reduced', () => {
  installMatchMedia(false)
  const writes = animationWrites()
  window.Function(loopScript)()
  const boot = document.getElementById('boot')
  const last = document.querySelector('.petal:last-of-type')
  last?.dispatchEvent(new Event('animationend'))
  if (boot) boot.dataset.state = 'done'
  vi.advanceTimersByTime(1000)
  expect(writes).toEqual([])

  document.body.innerHTML = bootHtml
  installMatchMedia(true)
  window.Function(loopScript)()
  document.querySelector('.petal:last-of-type')?.dispatchEvent(new Event('animationend'))
  vi.advanceTimersByTime(2000)
  expect(writes).toEqual([])
})
