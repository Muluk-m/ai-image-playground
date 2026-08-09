import type { QueryClient } from '@tanstack/react-query'
import type { AnyRouter } from '@tanstack/react-router'

// admin api client: 同源 fetch，自动带 cookie（HttpOnly session）。
// - 200 → 解 JSON 返回
// - 401 → 默认清 query cache + navigate /login，throw UnauthorizedError
// - 登录态探测可关闭全局跳转，由 route 自己决定如何处理 401
// - 其它 4xx/5xx → throw ApiError，调用方按需 catch

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`)
    this.name = 'ApiError'
  }
}

export class UnauthorizedError extends ApiError {
  constructor(body: unknown) {
    super(401, body, 'unauthorized')
    this.name = 'UnauthorizedError'
  }
}

// router / queryClient 由 main.tsx 启动后注入，避免 api-client.ts ↔ main.tsx
// 循环依赖（main.tsx 也 import api-client 的话）。
let _router: AnyRouter | null = null
let _queryClient: QueryClient | null = null

export function setApiClientRefs(refs: { router: AnyRouter; queryClient: QueryClient }): void {
  _router = refs.router
  _queryClient = refs.queryClient
}

// 测试 hook：重置全局 refs，避免测试间状态泄漏
export function _resetApiClientRefsForTest(): void {
  _router = null
  _queryClient = null
}

interface RequestOptions {
  redirectOnUnauthorized?: boolean
}

async function handleResponse<T>(res: Response, options?: RequestOptions): Promise<T> {
  if (res.status === 401) {
    const body = await safeParseJson(res)
    if (options?.redirectOnUnauthorized !== false) {
      _queryClient?.clear()
      if (_router) {
        // 不 await：navigate 可能在 promise 链里触发渲染递归
        void _router.navigate({ to: '/login' })
      }
    }
    throw new UnauthorizedError(body)
  }
  if (!res.ok) {
    const body = await safeParseJson(res)
    throw new ApiError(res.status, body)
  }
  // 204 / 空 body 时返 undefined as T（调用方自管）
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) return undefined as T
  return (await res.json()) as T
}

async function safeParseJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

export const apiClient = {
  async get<T>(url: string, options?: RequestOptions): Promise<T> {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    return handleResponse<T>(res, options)
  },
  async post<T>(url: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return handleResponse<T>(res, options)
  },
  async put<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    return handleResponse<T>(res)
  },
  async patch<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    return handleResponse<T>(res)
  },
}
