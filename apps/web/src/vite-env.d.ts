/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface ImportMetaEnv {
  readonly VITE_INSPIRATION_MANIFEST_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
