import type { AppLocale } from '../../i18n'

/**
 * 使用指南每种语言一个地址，都是构建期渲染好的独立页面（`apps/web/guide/**`），不属于 SPA 路由。
 * 以 `/` 结尾：Pages 与 nginx 按目录索引返回 `index.html`，canonical 也写这一种。
 */
export const GUIDE_PATHS: Record<AppLocale, string> = {
  'zh-CN': '/guide/',
  en: '/guide/en/',
}
