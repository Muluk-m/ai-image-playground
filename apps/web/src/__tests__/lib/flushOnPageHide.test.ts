// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { flushOnPageHide } from '../../lib/flushOnPageHide'

const registered: (() => void)[] = []

/** 注册表是模块级的，用例之间必须各自摘干净。 */
function register(flush: () => void) {
  const stop = flushOnPageHide(flush)
  registered.push(stop)
  return stop
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
}

function hide() {
  setVisibility('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  for (const stop of registered.splice(0)) stop()
  setVisibility('visible')
})

it('页面被藏起来之前把登记过的东西冲一遍', () => {
  const flush = vi.fn()
  register(flush)
  window.dispatchEvent(new Event('pagehide'))
  expect(flush).toHaveBeenCalledTimes(1)
})

it('注销之后不再被冲', () => {
  const flush = vi.fn()
  register(flush)()
  window.dispatchEvent(new Event('pagehide'))
  expect(flush).not.toHaveBeenCalled()
})

it('切到后台时冲，切回前台时不冲', () => {
  const flush = vi.fn()
  register(flush)
  hide()
  expect(flush).toHaveBeenCalledTimes(1)
  setVisibility('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(flush).toHaveBeenCalledTimes(1)
})

it('一个登记项冲不下去，其它的照冲', () => {
  const broken = vi.fn(() => {
    throw new Error('flush failed')
  })
  const flush = vi.fn()
  register(broken)
  register(flush)
  window.dispatchEvent(new Event('pagehide'))
  expect(broken).toHaveBeenCalledTimes(1)
  expect(flush).toHaveBeenCalledTimes(1)
})

it('多个登记项各被冲一次，监听不会随登记次数翻倍', () => {
  const first = vi.fn()
  const second = vi.fn()
  register(first)
  register(second)
  window.dispatchEvent(new Event('pagehide'))
  hide()
  expect(first).toHaveBeenCalledTimes(2)
  expect(second).toHaveBeenCalledTimes(2)
})
