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
  /** 用户的选择；没选过时是暗色。`system` 表示跟随系统，此刻生效的仍看 `theme`。 */
  choice: ThemeChoice
  setChoice: (next: ThemeChoice) => void
}

/** 主题的当前值与切换：头像菜单的三段开关（`ThemeSwitch`）在用。 */
export function useTheme(): ThemeControls {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'dark' as const)
  const choice = useSyncExternalStore(subscribeTheme, getThemeChoice, () => 'dark' as const)
  return { theme, choice, setChoice: setThemeChoice }
}
