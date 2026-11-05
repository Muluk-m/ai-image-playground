/** 除画布外每个入口的地址。画布用项目地址 `/p/<项目>`，没有项目时是 `/`。 */
export const APP_MODE_PATHS = {
  image: '/image',
  explore: '/explore',
  library: '/assets',
  tools: '/tools',
} as const

export type RoutedAppMode = keyof typeof APP_MODE_PATHS

/** 工具箱里每件工具一个地址：`/tools/<工具>`。目录页仍是 `/tools`。 */
export const TOOL_ROUTE_PATTERN = '/tools/:tool'
const TOOL_ROUTE = /^\/tools\/([^/]+)$/

/** `/tools/<工具>` 里的那段工具名；不是工具地址时返回 null。认不认得这件工具由工具箱判断。 */
export function toolRouteSlug(pathname: string): string | null {
  const match = TOOL_ROUTE.exec(normalizePath(pathname))
  return match ? match[1] : null
}

/** 项目曾经是独立入口 `/projects`；现在它是资产里的一个标签，老地址仍然认，落到资产。 */
export const LEGACY_PROJECTS_PATH = '/projects'

/** 定价页。它不是工作台入口，侧栏不收它。 */
export const PRICING_PATH = '/pricing'

/** 服务条款与隐私政策。同样不是工作台入口。 */
export const TERMS_PATH = '/terms'
export const PRIVACY_PATH = '/privacy'

/** CLI 设备授权确认页（终端打印的链接落到这里）。不是工作台入口。 */
export const CLI_DEVICE_PATH = '/device'

/** CLI 接入页：安装、连接账户、管理已连接设备。不是工作台入口。 */
export const CLI_CONNECT_PATH = '/connect'

/**
 * 版本公告。挂在工作台主区，侧栏「更新」进来，不是四个主入口之一。
 * 仍算独立地址：登录回跳留在这一页，但选侧栏入口会离开它。
 */
export const CHANGELOG_PATH = '/changelog'

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

/** CLI 接入整页。 */
export function isCliConnectPath(pathname: string): boolean {
  return normalizePath(pathname) === CLI_CONNECT_PATH
}

/** 整页文档：切工作台入口时不能把地址改掉。 */
export function isCliDevicePath(pathname: string): boolean {
  return normalizePath(pathname) === CLI_DEVICE_PATH
}

export function isChangelogPath(pathname: string): boolean {
  return normalizePath(pathname) === CHANGELOG_PATH
}

/** 画布全屏只在不看更新时占住主区。人在项目里打开更新，主区要换成更新页。 */
export function canvasOwnsMainPane(appMode: string, pathname: string): boolean {
  return appMode === 'canvas' && !isChangelogPath(pathname)
}

export function isStandalonePath(pathname: string): boolean {
  const path = normalizePath(pathname)
  return (
    path === PRICING_PATH ||
    path === TERMS_PATH ||
    path === PRIVACY_PATH ||
    path === CLI_DEVICE_PATH ||
    path === CLI_CONNECT_PATH ||
    path === CHANGELOG_PATH
  )
}

/** 地址属于某个入口时返回它；其余（项目地址、`/`、定价页、未知路径）返回 null。 */
export function pathAppMode(pathname: string): RoutedAppMode | null {
  const path = normalizePath(pathname)
  if (path === LEGACY_PROJECTS_PATH) return 'library'
  if (toolRouteSlug(path) !== null) return 'tools'
  for (const [mode, modePath] of Object.entries(APP_MODE_PATHS))
    if (path === modePath) return mode as RoutedAppMode
  return null
}
