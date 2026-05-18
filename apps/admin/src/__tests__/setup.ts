import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// RTL 在 vitest 下默认不自动 cleanup（jest 全局自动；vitest 需要显式）
afterEach(() => {
  cleanup()
})
