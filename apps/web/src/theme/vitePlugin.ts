import { THEME_BOOT_SCRIPT } from './bootScript'

/** 把首帧主题脚本内联进 head 最前面。形状是 Vite 的 Plugin，这里不 import vite 以免把它带进应用的类型图。 */
export function themeBootPlugin() {
  return {
    name: 'theme-boot-script',
    transformIndexHtml() {
      return [{ tag: 'script', children: THEME_BOOT_SCRIPT, injectTo: 'head-prepend' as const }]
    },
  }
}
