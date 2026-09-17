import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrapLocale } from './i18n'
import './index.css'
import { restoreLocalStorage } from './lib/localCompatibility/bridge'
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
const restored =
  !runtime.localCompatibility || (await restoreLocalStorage(runtime.localCompatibility))
if (!restored && runtime.localCompatibility) {
  const fallback = new URL(runtime.localCompatibility.sourceOrigin)
  fallback.pathname = location.pathname
  fallback.search = location.search
  fallback.hash = location.hash
  location.replace(fallback.href)
} else {
  const [{ AuthGate }, { bootstrapChannels }, { bootstrapClientCapabilities }] = await Promise.all([
    import('./auth/AuthGate'),
    import('./lib/channels/bootstrapChannels'),
    import('./lib/clientCapabilities'),
  ])
  await Promise.all([
    // 英文语料是按需 chunk，首帧之前就得落地，否则登录页会先闪一遍中文。
    bootstrapLocale(),
    bootstrapClientCapabilities(runtime.bff.enabled, runtime.bff.baseUrl),
    bootstrapChannels(runtime.bff.enabled, runtime.bff.baseUrl),
  ])

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthGate />
    </StrictMode>,
  )
}
