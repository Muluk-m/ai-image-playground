import type { AuthUserView } from '@image-playground/shared'
import { createContext, useContext } from 'react'

export interface AuthContextValue {
  enabled: boolean
  user: AuthUserView | null
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  enabled: false,
  user: null,
  logout: async () => {},
})

export const AuthContextProvider = AuthContext.Provider

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
