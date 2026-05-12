import type { ProviderKind } from './channels/types'
import { getApiErrorMessage } from './imageApiShared'

export interface FetchProfileModelsInput {
  baseUrl: string
  apiKey: string
  kind: ProviderKind
}

/**
 * 从上游 API 拉取该 profile 支持的模型 ID 列表。
 *
 * 协议适配：
 * - openai-compat：GET {baseUrl}/models with Authorization: Bearer
 *   响应形如 { data: [{ id: '...' }] } 或 { data: ['...'] }
 * - gemini：GET {baseUrl}/models with x-api-key
 *   响应形如 { models: [{ name: 'models/gemini-...' }] }，需从 name 提取末段
 *
 * 失败抛 Error；成功返回去重排序后的 model id 列表。
 */
export async function fetchProfileModels(input: FetchProfileModelsInput, signal?: AbortSignal): Promise<string[]> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('请先填写 API URL')
  if (!input.apiKey.trim()) throw new Error('请先填写 API Key')

  const url = `${baseUrl}/models`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (input.kind === 'gemini') {
    headers['x-api-key'] = input.apiKey
  } else {
    headers.Authorization = `Bearer ${input.apiKey}`
  }

  const response = await fetch(url, { method: 'GET', headers, signal })
  if (!response.ok) {
    throw new Error(await getApiErrorMessage(response))
  }

  const payload = (await response.json()) as unknown
  const ids = extractModelIds(payload)
  if (!ids.length) {
    throw new Error('接口返回中未找到可识别的模型列表')
  }
  return ids
}

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []

  const data = (payload as Record<string, unknown>).data
  if (Array.isArray(data)) {
    const ids = data
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string') {
          return (item as Record<string, string>).id
        }
        return ''
      })
      .filter(Boolean)
    if (ids.length) return uniqueSorted(ids)
  }

  const models = (payload as Record<string, unknown>).models
  if (Array.isArray(models)) {
    const ids = models
      .map((item) => {
        if (typeof item === 'string') return stripModelsPrefix(item)
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') {
          return stripModelsPrefix((item as Record<string, string>).name)
        }
        return ''
      })
      .filter(Boolean)
    if (ids.length) return uniqueSorted(ids)
  }

  return []
}

function stripModelsPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name
}

function uniqueSorted(list: string[]): string[] {
  return Array.from(new Set(list)).sort()
}
