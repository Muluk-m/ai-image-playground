// Shared by the inline startup guard (via vite.config.ts) and the app bundle, so keep it dependency-free.
export const BOOT_READY_EVENT = 'app:boot-ready'
export const PRELOAD_RELOAD_STORAGE_KEY = 'aip.preload-reload-at'
export const RELOAD_QUERY_PARAM = '__aip_reload'
/** apps/web/src/lib/deviceId.ts 的存储键；启动守卫上报时也要读它。 */
export const DEVICE_ID_STORAGE_KEY = 'image-playground.device_id'
/** 构建时注入 index.html 的构建标识（见 vitePlugin），错误上报拿它当 release。 */
export const BUILD_META_NAME = 'aip-html-build'
