import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom 不实现 scrollIntoView，滚动到当前项的组件在测试环境会直接抛错
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// RTL 在 vitest 下默认不自动 cleanup（jest 全局自动；vitest 需要显式）
afterEach(() => {
  cleanup()
})
