/** 除画布外每个入口的地址。画布用项目地址 `/p/<项目>`，没有项目时是 `/`。 */
export const APP_MODE_PATHS = {
  /** 创作页的 canonical 地址是站点根，旧 `/image` 规范化跳到这里。 */
  image: '/',
  explore: '/explore',
  library: '/assets',
  tools: '/tools',
} as const

/** 工作台静态入口；仅供首页的会话选择脚本使用，不是公开 canonical 地址。 */
export const WORKBENCH_ENTRY_PATH = '/workbench'
export const LEGACY_IMAGE_PATH = '/image'

export type RoutedAppMode = keyof typeof APP_MODE_PATHS

/** 项目曾经是独立入口 `/projects`；现在它是资产里的一个标签，老地址仍然认，落到资产。 */
export const LEGACY_PROJECTS_PATH = '/projects'

/** 定价页。它不是工作台入口，侧栏不收它。 */
export const PRICING_PATH = '/pricing'

/** 服务条款与隐私政策。同样不是工作台入口。 */
export const TERMS_PATH = '/terms'
export const PRIVACY_PATH = '/privacy'

export function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/'
}

export function isPricingPath(pathname: string): boolean {
  return normalizePath(pathname) === PRICING_PATH
}

export function isTermsPath(pathname: string): boolean {
  return normalizePath(pathname) === TERMS_PATH
}

export function isPrivacyPath(pathname: string): boolean {
  return normalizePath(pathname) === PRIVACY_PATH
}

/** 整页文档：切工作台入口时不能把地址改掉。 */
export function isStandalonePath(pathname: string): boolean {
  const path = normalizePath(pathname)
  return path === PRICING_PATH || path === TERMS_PATH || path === PRIVACY_PATH
}

/** 地址属于某个入口时返回它；旧 `/image` 由工作台启动同步规范化，其他未知路径返回 null。 */
export function pathAppMode(pathname: string): RoutedAppMode | null {
  const path = normalizePath(pathname)
  if (path === LEGACY_PROJECTS_PATH) return 'library'
  for (const [mode, modePath] of Object.entries(APP_MODE_PATHS))
    if (path === modePath) return mode as RoutedAppMode
  return null
}
