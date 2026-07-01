/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __DEV_PROXY_CONFIG__: unknown

interface ImportMetaEnv {
  readonly VITE_DEFAULT_API_URL?: string
  readonly VITE_INSPIRATION_MANIFEST_URL?: string
  /**
   * tldraw license key（免费 watermark 版即可）。生产域名下缺此 key，tldraw 会在
   * 渲染 5 秒后隐藏整个画布（unlicensed-production）。免费申请：https://tldraw.dev
   */
  readonly VITE_TLDRAW_LICENSE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
