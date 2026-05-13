// Tombstone SW：项目已废弃 Service Worker（cache-first 误缓存 API 响应，
// 且升级链路在 cf tunnel + 浏览器多层缓存下不可控）。
//
// 历史已注册 SW 的客户端 fetch 到此文件后：
//   1. install 阶段 skipWaiting，立刻取代旧 SW
//   2. activate 阶段清空本 origin 下所有 cache + 注销自己
//   3. 注销后下一次刷新，页面就不再受任何 SW 控制
//
// __BUILD_VERSION__ 由 vite build 时 injectSwBuildVersion plugin 替换为
// 每次构建唯一的 token，确保浏览器一定 fetch 新版本而非用 HTTP 缓存的旧 SW。
self.addEventListener('install', (event) => {
  void event
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys()
        await Promise.all(keys.map((key) => caches.delete(key)))
      } catch {
        /* ignore */
      }
      try {
        await self.registration.unregister()
      } catch {
        /* ignore */
      }
      // 让仍在前台的页面立刻刷新一下，确保后续请求脱离 SW 控制。
      try {
        const clients = await self.clients.matchAll({ type: 'window' })
        for (const client of clients) {
          if ('navigate' in client) client.navigate(client.url)
        }
      } catch {
        /* ignore */
      }
    })(),
  )
})

// fetch 事件不再 respondWith，所有请求直连网络。
// build_token=__BUILD_VERSION__
