import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthGate } from './auth/AuthGate'
import './index.css'
import { bootstrapChannels } from './lib/channels/bootstrapChannels'
import { bootstrapClientCapabilities } from './lib/clientCapabilities'
import { loadRuntimeConfig } from './lib/runtimeConfig'
import { installMobileViewportGuards } from './lib/viewport'

installMobileViewportGuards()

// 不再注册 Service Worker：早期版本的 cache-first SW 会误缓存 API 响应
// （/v1/* 队列 status 等），且 SW 升级链路在 cf tunnel + 浏览器多层缓存下
// 行为难以预期。统一改为「无 SW」模式，所有请求直连。
//
// 历史已注册 SW 的客户端：访问页面时 fetch /sw.js 拿到的是自卸载版本，
// install 后立即调 registration.unregister() 解除自身，下次刷新就彻底干净。
// 这里额外做一次主动 unregister 作为兜底。
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => {
      void registration.unregister()
    })
  })
}

// Capabilities and channel discovery share one startup round trip. The channel request can return
// 401 before login; AuthGate retries it after establishing an authenticated session.
const runtime = await loadRuntimeConfig()
await Promise.all([
  bootstrapClientCapabilities(runtime.bff.enabled, runtime.bff.baseUrl),
  bootstrapChannels(runtime.bff.enabled, runtime.bff.baseUrl),
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
)
