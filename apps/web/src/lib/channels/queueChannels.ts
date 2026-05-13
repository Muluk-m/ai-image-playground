import type { ChannelDefaults, ChannelModel, PublicChannel } from './types'

/**
 * 构建期 env `VITE_BFF_QUEUE_CHANNELS` 注入的 queue channel 列表。
 *
 * 与内置 builtin-edge channels（config/channels.json）平行：
 * - 不经 CF Pages Function；客户端直接 fetch `<bffBaseUrl>/v1/queue/...`
 * - 鉴权由 BFF 端（或 cf tunnel access policy）控制，前端不持 secret
 *
 * Schema（JSON 数组）示例：
 * [
 *   {
 *     "id": "qlj-bff-openai",
 *     "kind": "openai-queue",
 *     "label": "qlj BFF · OpenAI",
 *     "bffBaseUrl": "https://bff.example.com",
 *     "models": [{ "id": "gpt-image-2", "label": "GPT Image 2" }],
 *     "defaults": { "apiMode": "images", "timeout": 600 }
 *   }
 * ]
 */
function parseQueueChannels(raw: unknown): PublicChannel[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn('[queue-channels] VITE_BFF_QUEUE_CHANNELS 不是合法 JSON，已忽略', err)
    return []
  }
  if (!Array.isArray(parsed)) {
    console.warn('[queue-channels] VITE_BFF_QUEUE_CHANNELS 必须是数组，已忽略')
    return []
  }
  return parsed.flatMap((entry) => normalizeOne(entry)).filter((c): c is PublicChannel => c !== null)
}

function normalizeOne(entry: unknown): PublicChannel | null {
  if (!entry || typeof entry !== 'object') return null
  const r = entry as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : ''
  const kind = r.kind
  const label = typeof r.label === 'string' ? r.label : id
  const bffBaseUrl = typeof r.bffBaseUrl === 'string' ? r.bffBaseUrl.replace(/\/+$/, '') : ''
  const models = normalizeModels(r.models)
  const defaults = normalizeDefaults(r.defaults)

  // bffBaseUrl 缺省 / 空串视为同源（fetch 用相对路径直接走 BFF same-origin）
  if (!id) return null
  if (kind !== 'openai-queue' && kind !== 'gemini-queue') return null
  if (!models.length) return null

  return { id, kind, label, models, defaults, bffBaseUrl }
}

function normalizeModels(value: unknown): ChannelModel[] {
  if (!Array.isArray(value)) return []
  return value
    .map((m): ChannelModel | null => {
      if (!m || typeof m !== 'object') return null
      const r = m as Record<string, unknown>
      if (typeof r.id !== 'string' || !r.id) return null
      return {
        id: r.id,
        label: typeof r.label === 'string' && r.label ? r.label : r.id,
        ...(Array.isArray(r.capabilities) ? { capabilities: r.capabilities as ChannelModel['capabilities'] } : {}),
      }
    })
    .filter((m): m is ChannelModel => m !== null)
}

function normalizeDefaults(value: unknown): ChannelDefaults {
  const r = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    apiMode: r.apiMode === 'responses' ? 'responses' : 'images',
    timeout: typeof r.timeout === 'number' ? r.timeout : 600,
    ...(typeof r.codexCli === 'boolean' ? { codexCli: r.codexCli } : {}),
    ...(typeof r.responseFormatB64Json === 'boolean' ? { responseFormatB64Json: r.responseFormatB64Json } : {}),
  }
}

const IS_TEST = import.meta.env.MODE === 'test'
const RAW = import.meta.env.VITE_BFF_QUEUE_CHANNELS as string | undefined

export const QUEUE_CHANNELS: PublicChannel[] = IS_TEST ? [] : parseQueueChannels(RAW)
