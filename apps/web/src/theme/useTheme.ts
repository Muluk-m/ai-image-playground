import { useSyncExternalStore } from 'react'
import {
  getTheme,
  getThemeChoice,
  setThemeChoice,
  subscribeTheme,
  type Theme,
  type ThemeChoice,
} from '.'

export interface ThemeControls {
  /** 此刻生效的主题。 */
  theme: Theme
  /** 用户的选择；没选过时是暗色。 */
  choice: ThemeChoice
  setChoice: (next: ThemeChoice) => void
}

/** 主题的当前值与切换：头像菜单的主题下拉（`DisplaySettingsFields`）与设计系统陈列页在用。 */
export function useTheme(): ThemeControls {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'dark' as const)
  const choice = useSyncExternalStore(subscribeTheme, getThemeChoice, () => 'dark' as const)
  return { theme, choice, setChoice: setThemeChoice }
}
