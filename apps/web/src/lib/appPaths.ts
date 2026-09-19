/** 除画布外每个入口的地址。画布用项目地址 `/p/<项目>`，没有项目时是 `/`。 */
export const APP_MODE_PATHS = {
  image: '/image',
  video: '/video',
  works: '/works',
  assets: '/assets',
  templates: '/templates',
  projects: '/projects',
} as const

export type RoutedAppMode = keyof typeof APP_MODE_PATHS

/** 地址属于某个入口时返回它；其余（项目地址、`/`、未知路径）返回 null。 */
export function pathAppMode(pathname: string): RoutedAppMode | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  for (const [mode, modePath] of Object.entries(APP_MODE_PATHS))
    if (path === modePath) return mode as RoutedAppMode
  return null
}
