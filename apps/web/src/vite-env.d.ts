/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __CLI_GUIDE_REV__: string
declare const __CLI_INSTALL_SH_SHA256__: string
declare const __CLI_INSTALL_PS1_SHA256__: string

interface ImportMetaEnv {
  readonly VITE_INSPIRATION_MANIFEST_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
