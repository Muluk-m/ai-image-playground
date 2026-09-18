/** 作品、视频两个入口的地址。创作用项目地址 `/p/<项目>`，没有项目时是 `/`。 */
export const APP_MODE_PATHS = { browse: '/works', video: '/video' } as const

export type RoutedAppMode = keyof typeof APP_MODE_PATHS

/** 地址是作品或视频入口时返回它；其余（项目地址、`/`、未知路径）返回 null。 */
export function pathAppMode(pathname: string): RoutedAppMode | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  for (const [mode, modePath] of Object.entries(APP_MODE_PATHS))
    if (path === modePath) return mode as RoutedAppMode
  return null
}
