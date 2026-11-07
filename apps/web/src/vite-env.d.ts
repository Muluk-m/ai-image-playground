/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __CLI_GUIDE_REV__: string

interface ImportMetaEnv {
  readonly VITE_INSPIRATION_MANIFEST_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
