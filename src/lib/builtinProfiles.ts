import type { ApiProfile } from '../types'
import { BUILTIN_PROFILE_ID_PREFIX, normalizeApiProfile } from './apiProfiles'

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

export const BUILTIN_PROFILES: ApiProfile[] = parseBuiltinProfiles(readEnvJson())
