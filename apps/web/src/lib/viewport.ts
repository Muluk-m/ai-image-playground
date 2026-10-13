const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1.0, viewport-fit=cover'

/** 同步首屏 viewport。不再锁缩放：捏合缩放要能用，输入框改用 ≥16px 避免 iOS 聚焦放大。 */
export function installMobileViewportGuards() {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (viewport) viewport.content = VIEWPORT_CONTENT
}
