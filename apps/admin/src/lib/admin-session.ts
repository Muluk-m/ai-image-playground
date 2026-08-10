import { queryOptions } from '@tanstack/react-query'

import type { AdminSession } from '../../contracts'
import { apiClient } from './api-client'

export const adminSessionQueryOptions = queryOptions({
  queryKey: ['me'],
  queryFn: () =>
    apiClient.get<AdminSession>('/api/me', {
      redirectOnUnauthorized: false,
    }),
  staleTime: 60_000,
})
