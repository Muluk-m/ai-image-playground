import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom 不实现 scrollIntoView，滚动到当前项的组件在测试环境会直接抛错
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// jsdom 没有 scrollTo，router 的滚动恢复每次导航都会往 stderr 抛 not-implemented
window.scrollTo = () => {}

// jsdom 没有 matchMedia / ResizeObserver：sidebar 的断点判断与 recharts 的容器测量都要用
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
