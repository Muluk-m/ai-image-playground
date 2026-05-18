/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __DEV_PROXY_CONFIG__: unknown

interface ImportMetaEnv {
  readonly VITE_DEFAULT_API_URL?: string
  readonly VITE_INSPIRATION_MANIFEST_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
