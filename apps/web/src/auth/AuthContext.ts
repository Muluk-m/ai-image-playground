import type { AuthUserView } from '@image-playground/shared'
import { createContext, useContext } from 'react'

export interface AuthContextValue {
  enabled: boolean
  user: AuthUserView | null
  /** 打开登录框。未登录访客点「登录」，或会话过期后点「重新登录」都走这里。 */
  login: () => void
  logout: (clearLocalData: boolean) => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  enabled: false,
  user: null,
  login: () => {},
  logout: async () => {},
})

export const AuthContextProvider = AuthContext.Provider

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
