import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrapLocale } from './i18n'
import './index.css'
import { legacyFallback, restoreLogin } from './lib/localCompatibility/auth'
import { restoreLocalStorage } from './lib/localCompatibility/bridge'
import { loadRuntimeConfig } from './lib/runtimeConfig'
import { installMobileViewportGuards } from './lib/viewport'
import { initTheme } from './theme'

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

/**
 * 启动链原本是串的：JS → 运行时配置 → 分片 → 能力/频道 → 首帧。每一环都是一个往返，
 * 冷启动整屏黑 3.8s。这里把不依赖配置的两件事（首帧分片、语料）在第一行就发出去，
 * 与配置请求并行；闪屏由 index.html 负责，挂载时摘掉。
 */
const gateModules = Promise.all([
  import('./auth/AuthGate'),
  import('./lib/channels/bootstrapChannels'),
  import('./lib/clientCapabilities'),
])
const localeReady = bootstrapLocale()

function dismissBootSplash(): void {
  const boot = document.getElementById('boot')
  if (!boot) return
  boot.classList.add('is-done')
  boot.addEventListener('transitionend', () => boot.remove(), { once: true })
  setTimeout(() => boot.remove(), 400)
}

// Capabilities and channel discovery share one startup round trip. The channel request can return
// 401 before login; AuthGate retries it after establishing an authenticated session.
const runtime = await loadRuntimeConfig()
const restored =
  !runtime.localCompatibility || (await restoreLocalStorage(runtime.localCompatibility))
if (!restored && runtime.localCompatibility) {
  location.replace(legacyFallback(runtime.localCompatibility))
} else if (
  !runtime.localCompatibility ||
  !runtime.bff.enabled ||
  (await restoreLogin(runtime.localCompatibility, runtime.bff.baseUrl))
) {
  // 首帧的明暗已由 index.html 里的内联脚本定好；这里在旧站数据搬完之后接手后续变化。
  initTheme()
  const [{ AuthGate }, { bootstrapChannels }, { bootstrapClientCapabilities }] = await gateModules
  // 频道清单只决定模型下拉里有什么，首帧不等它；能力决定登录页还是工作台，必须等。
  void bootstrapChannels(runtime.bff.enabled, runtime.bff.baseUrl)
  await Promise.all([
    // 英文语料是按需 chunk，首帧之前就得落地，否则登录页会先闪一遍中文。
    localeReady,
    bootstrapClientCapabilities(runtime.bff.enabled, runtime.bff.baseUrl),
  ])

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthGate />
    </StrictMode>,
  )
  dismissBootSplash()
}
