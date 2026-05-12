import type { ApiProfile } from '../types'
import { BUILTIN_PROFILE_ID_PREFIX, normalizeApiProfile } from './apiProfiles'

const SUB2API_GEMINI_MODELS = [
  'gemini-3.1-flash-image',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
]

export const DEFAULT_BUILTIN_PROFILES: ApiProfile[] = [
  {
    id: 'builtin-sub2api-gemini',
    name: 'sub2api · Gemini',
    provider: 'gemini',
    baseUrl: 'https://sub2api.qiliangjia.one/antigravity/v1beta',
    apiKey: 'sk-487f010b880b316af4b0adfa36c9c5e12dc0d0b1b5d7573618310d7c11d76e3e',
    model: 'gemini-3.1-flash-image',
    timeout: 600,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    models: SUB2API_GEMINI_MODELS,
  },
]

function ensureBuiltinId(rawId: unknown, fallbackBase: string, used: Set<string>): string {
  const base = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : fallbackBase
  const prefixed = base.startsWith(BUILTIN_PROFILE_ID_PREFIX) ? base : `${BUILTIN_PROFILE_ID_PREFIX}${base}`
  let id = prefixed
  let n = 2
  while (used.has(id)) {
    id = `${prefixed}-${n}`
    n += 1
  }
  used.add(id)
  return id
}

export function parseBuiltinProfiles(raw: string | undefined | null): ApiProfile[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const used = new Set<string>()
  const profiles: ApiProfile[] = []
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i]
    if (!item || typeof item !== 'object') continue
    const normalized = normalizeApiProfile(item)
    const id = ensureBuiltinId((item as Record<string, unknown>).id, `entry-${i}`, used)
    profiles.push({ ...normalized, id })
  }
  return profiles
}

function readEnvJson(): string | undefined {
  const env = import.meta.env as Record<string, unknown> | undefined
  const value = env?.VITE_BUILTIN_PROFILES
  return typeof value === 'string' ? value : undefined
}

function isTestMode(): boolean {
  const env = import.meta.env as { MODE?: string } | undefined
  return env?.MODE === 'test'
}

let cached: ApiProfile[] | null = null

export function getBuiltinProfiles(): ApiProfile[] {
  if (cached) return cached
  const fromEnv = parseBuiltinProfiles(readEnvJson())
  if (fromEnv.length) {
    cached = fromEnv
  } else if (isTestMode()) {
    cached = []
  } else {
    cached = DEFAULT_BUILTIN_PROFILES
  }
  return cached
}
