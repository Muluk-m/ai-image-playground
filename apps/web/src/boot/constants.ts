// Shared by the inline startup guard (via vite.config.ts) and the app bundle, so keep it dependency-free.
export const BOOT_READY_EVENT = 'app:boot-ready'
export const PRELOAD_RELOAD_STORAGE_KEY = 'aip.preload-reload-at'
