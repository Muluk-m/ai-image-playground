/** 除画布外每个入口的地址。画布用项目地址 `/p/<项目>`，没有项目时是 `/`。 */
export const APP_MODE_PATHS = {
  image: '/image',
  explore: '/explore',
  library: '/assets',
  tools: '/tools',
} as const

export type RoutedAppMode = keyof typeof APP_MODE_PATHS

/** 项目曾经是独立入口 `/projects`；现在它是资产里的一个标签，老地址仍然认，落到资产。 */
export const LEGACY_PROJECTS_PATH = '/projects'

/** 地址属于某个入口时返回它；其余（项目地址、`/`、未知路径）返回 null。 */
export function pathAppMode(pathname: string): RoutedAppMode | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === LEGACY_PROJECTS_PATH) return 'library'
  for (const [mode, modePath] of Object.entries(APP_MODE_PATHS))
    if (path === modePath) return mode as RoutedAppMode
  return null
}
