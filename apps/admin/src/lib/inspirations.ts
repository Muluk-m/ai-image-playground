import type {
  AgentSkillSummary,
  InspirationAdminItem,
  InspirationCategory,
  InspirationKind,
  InspirationStatus,
  InspirationWriteInput,
} from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError, apiClient } from './api-client'

export interface InspirationListFilters {
  status?: InspirationStatus | 'all'
  kind?: InspirationKind | 'all'
  q?: string
}

/** 灵感条目与分类互相影响（分类被引用就删不掉），所以两把 key 各自失效，不混用。 */
const ITEMS_KEY = ['inspirations'] as const
const CATEGORIES_KEY = ['inspiration-categories'] as const

function listQuery(filters: InspirationListFilters): string {
  const search = new URLSearchParams()
  if (filters.status && filters.status !== 'all') search.set('status', filters.status)
  if (filters.kind && filters.kind !== 'all') search.set('kind', filters.kind)
  const term = filters.q?.trim()
  if (term) search.set('q', term)
  return search.size ? `?${search}` : ''
}

export function useInspirations(filters: InspirationListFilters = {}) {
  const status = filters.status ?? 'all'
  const kind = filters.kind ?? 'all'
  const q = filters.q?.trim() ?? ''
  return useQuery({
    queryKey: [...ITEMS_KEY, { status, kind, q }],
    queryFn: () =>
      apiClient.get<InspirationAdminItem[]>(`/api/inspirations${listQuery({ status, kind, q })}`),
  })
}

/**
 * 抽屉按 id 单独取一份：⌘K 可以跳到任何一条，而它未必落在列表当前的筛选里。
 * key 挂在 ITEMS_KEY 下，任何写操作的 invalidate 顺带把打开的抽屉刷新掉。
 */
export function useInspiration(id: string | null) {
  return useQuery({
    queryKey: [...ITEMS_KEY, 'detail', id],
    queryFn: () =>
      apiClient.get<InspirationAdminItem>(`/api/inspirations/${encodeURIComponent(id!)}`),
    enabled: typeof id === 'string' && id.length > 0,
  })
}

export function useInspirationCategories() {
  return useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: () => apiClient.get<InspirationCategory[]>('/api/inspiration-categories'),
  })
}

/**
 * 部署技能目录。正文随 BFF 镜像发布（ADR 0007），后台只读，所以这份清单在一次
 * 会话里不会变——给足够长的 staleTime，切页签不重复打接口。
 */
export function useAgentSkillCatalog(mode: 'image' | 'video' = 'image') {
  return useQuery({
    queryKey: ['agent-skills', mode],
    queryFn: async () => {
      const result = await apiClient.get<{ skills: AgentSkillSummary[] }>(
        `/api/skills?mode=${mode}`,
      )
      return result.skills
    },
    staleTime: 5 * 60_000,
  })
}

export function useCreateInspiration() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: InspirationWriteInput) =>
      apiClient.post<{ item: InspirationAdminItem }>('/api/inspirations', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ITEMS_KEY }),
  })
}

export function useUpdateInspiration() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: InspirationWriteInput) =>
      apiClient.put<{ item: InspirationAdminItem }>(
        `/api/inspirations/${encodeURIComponent(input.id)}`,
        input,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ITEMS_KEY }),
  })
}

export function useDeleteInspiration() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.del<{ ok: true }>(`/api/inspirations/${encodeURIComponent(id)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ITEMS_KEY }),
  })
}

export function useSetInspirationStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: InspirationStatus }) =>
      apiClient.post<{ item: InspirationAdminItem }>(
        `/api/inspirations/${encodeURIComponent(id)}/status`,
        { status },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ITEMS_KEY }),
  })
}

export function useCreateInspirationCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: InspirationCategory) =>
      apiClient.post<{ category: InspirationCategory }>('/api/inspiration-categories', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  })
}

export function useUpdateInspirationCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name, sort }: InspirationCategory) =>
      apiClient.put<{ category: InspirationCategory }>(
        `/api/inspiration-categories/${encodeURIComponent(id)}`,
        { name, sort },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  })
}

export function useDeleteInspirationCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.del<{ ok: true }>(`/api/inspiration-categories/${encodeURIComponent(id)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  })
}

export interface UploadedInspirationAsset {
  key: string
  publicUrl: string
}

/**
 * 两步上传：先问后台要公开桶的预签名 PUT，再把文件直接丢给对象存储。
 * 第二步**不能带 cookie**——预签名 URL 自带签名，多一个 Authorization/Cookie 头
 * 会让 S3 兼容端点按另一套鉴权算签名并拒签。
 */
export async function uploadInspirationAsset(file: File): Promise<UploadedInspirationAsset> {
  const target = await apiClient.post<{ uploadUrl: string; key: string; publicUrl: string }>(
    '/api/inspirations/uploads',
    { filename: file.name, contentType: file.type },
  )
  const uploaded = await fetch(target.uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'content-type': file.type },
  })
  if (!uploaded.ok) throw new ApiError(uploaded.status, { error: 'upload_failed' })
  return { key: target.key, publicUrl: target.publicUrl }
}

/**
 * 后台写接口的错误码翻译。运营看到的必须是「为什么不让我发」，不是 invalid_model。
 * 码表跟着 apps/bff/src/lib/inspirations.ts 的 InspirationOperationErrorCode 走。
 */
export function inspirationErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const code = (error.body as { error?: unknown }).error
    switch (code) {
      case 'invalid_model':
        return '推荐模型不在当前部署的渠道里'
      case 'invalid_skill':
        return '技能不在当前部署的技能目录里'
      case 'invalid_template':
        return '模板提示词至少要有一个 {槽位}'
      case 'published_item_must_be_archived':
        return '已发布条目要先下架才能删除'
      case 'category_in_use':
        return '分类下还有条目'
      case 'id_taken':
        return 'id 已被占用'
      case 'category_name_taken':
        return '分类名已存在'
      case 'item_not_found':
      case 'category_not_found':
        return '条目已不存在'
      case 'invalid_item':
        return '必填项没填全：标题、分类、提示词、推荐模型、封面和尺寸都要有'
      case 'upload_failed':
        return '上传到公开桶失败，请重试'
      case 'unsupported_content_type':
        return '只支持 PNG / JPEG / WebP / GIF'
      case 'content_type_mismatch':
        return '文件扩展名和实际类型对不上'
      default:
        break
    }
  }
  return '操作失败，请稍后重试'
}
