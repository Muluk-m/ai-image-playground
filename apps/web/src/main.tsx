import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { setChannels } from './lib/channels/channelStore'
import { fetchDiscoveredChannels } from './lib/channels/discoverChannels'
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

// Boot 阻塞：runtime config 决定后端形态，channel 列表决定 UI 有没有「内置」
// 选项 — 这两块必须在 React 渲染前定下来，否则首屏要么闪烁要么取错 baseUrl。
// 同源 BFF 下两次 fetch 都是 ~ms 级，对首屏无感。runtime-config.json 缺失
// （纯静态部署）走 BAKED_DEFAULTS = bff.enabled=false，下面 discovery 自然跳过。
//
// 跨域 BFF（cf tunnel）挂了的话，浏览器 fetch 默认要等几分钟才放弃 →
// SPA 卡白屏。给 channel discovery 一个 5s 硬超时，超时即退化 BYOK-only。
const BOOT_DISCOVERY_TIMEOUT_MS = 5000

const runtime = await loadRuntimeConfig()
if (runtime.bff.enabled) {
  try {
    const channels = await fetchDiscoveredChannels(runtime.bff.baseUrl, {
      signal: AbortSignal.timeout(BOOT_DISCOVERY_TIMEOUT_MS),
    })
    setChannels(channels)
  } catch (err) {
    console.warn(
      '[channel-discovery] BFF unreachable; UI will only offer BYOK profiles.',
      err instanceof Error ? err.message : err,
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
