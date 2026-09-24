import { useSyncExternalStore } from 'react'
import {
  getTheme,
  getThemeChoice,
  setThemeChoice,
  subscribeTheme,
  type Theme,
  type ThemeChoice,
} from './index'

export interface ThemeControls {
  /** 此刻生效的主题。 */
  theme: Theme
  /** 用户的选择；没选过时是暗色。 */
  choice: ThemeChoice
  setChoice: (next: ThemeChoice) => void
}

/** 主题下拉的状态。只在头像菜单里，由 `DisplaySettingsFields` 渲染。 */
export function useTheme(): ThemeControls {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'dark' as const)
  const choice = useSyncExternalStore(subscribeTheme, getThemeChoice, () => 'dark' as const)
  return { theme, choice, setChoice: setThemeChoice }
}
