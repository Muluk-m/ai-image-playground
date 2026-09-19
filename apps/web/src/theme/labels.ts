import type { ThemeChoice } from './index'

/** `common` 命名空间里的显示名。写成字面量表而不是模板拼 key，死 key 体检才搜得到。 */
export const THEME_LABEL_KEY = {
  system: 'theme.system',
  light: 'theme.light',
  dark: 'theme.dark',
} as const satisfies Record<ThemeChoice, string>
