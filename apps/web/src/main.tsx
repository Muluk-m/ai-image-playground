import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'

installMobileViewportGuards()

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register(`${import.meta.env.BASE_URL}sw.js`)
        .then((registration) => {
          // 每次页面打开主动 update()，让浏览器立刻去 fetch sw.js 检查新版本；
          // 配合 sw.js 的 cache-control: no-cache，能在第二次访问时拿到新 SW。
          void registration.update()
        })
        .catch((error) => {
          console.error('Service worker registration failed:', error)
        })

      // 新 SW 接管时（skipWaiting + clients.claim 后会触发 controllerchange），
      // 自动 reload 拿新 bundle，免去强刷。第一次安装也会触发但已经在新版本上。
      let reloading = false
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return
        reloading = true
        window.location.reload()
      })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
