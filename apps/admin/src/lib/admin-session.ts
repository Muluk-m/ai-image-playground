import { queryOptions } from '@tanstack/react-query'

import type { AdminLoginMethods, AdminSession } from '../../contracts'
import { apiClient } from './api-client'

export const adminSessionQueryOptions = queryOptions({
  queryKey: ['me'],
  queryFn: () =>
    apiClient.get<AdminSession>('/api/me', {
      redirectOnUnauthorized: false,
    }),
  staleTime: 60_000,
})

export const loginMethodsQueryOptions = queryOptions({
  queryKey: ['login-methods'],
  queryFn: () =>
    apiClient.get<AdminLoginMethods>('/api/auth/methods', {
      redirectOnUnauthorized: false,
    }),
  staleTime: 60_000,
})
