import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom 缺的浏览器 API：缺一个组件就抛一个，全部补成静默的空实现。
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
// scrollTo 例外：jsdom 定义了它但调用即抛 not-implemented，所以要无条件覆盖。
window.scrollTo = () => {}
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// RTL 在 vitest 下默认不自动 cleanup（jest 全局自动；vitest 需要显式）
afterEach(() => {
  cleanup()
})
