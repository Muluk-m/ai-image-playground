import type { ApiProfile } from '../types'
import { getApiErrorMessage } from './imageApiShared'

/**
 * 从上游 API 拉取该 profile 支持的模型 ID 列表。
 *
 * 协议适配：
 * - openai / 自定义 OpenAI 兼容：GET {baseUrl}/models with Authorization: Bearer
 *   响应形如 { data: [{ id: '...' }] } 或 { data: ['...'] }
 * - gemini：GET {baseUrl}/models with x-api-key
 *   响应形如 { models: [{ name: 'models/gemini-...' }] }，需从 name 提取末段
 * - fal：fal.ai 没有公开的标准 /models 端点 → 抛 unsupported
 *
 * 失败抛 Error；成功返回去重排序后的 model id 列表。
 */
export async function fetchProfileModels(profile: ApiProfile, signal?: AbortSignal): Promise<string[]> {
  if (profile.provider === 'fal') {
    throw new Error('fal.ai 不提供模型列表接口，请手动输入模型 ID')
  }

  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('请先填写 API URL')
  if (!profile.apiKey.trim()) throw new Error('请先填写 API Key')

  const url = `${baseUrl}/models`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (profile.provider === 'gemini') {
    headers['x-api-key'] = profile.apiKey
  } else {
    headers.Authorization = `Bearer ${profile.apiKey}`
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

  // OpenAI 兼容: { data: [{ id }] }
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

  // Gemini: { models: [{ name: 'models/gemini-...' }] }
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
