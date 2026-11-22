import { useSyncExternalStore } from 'react'
import { type AccountProfile, fetchProfile } from './profile-client'

export interface ProfileSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  profile: AccountProfile | null
}

const listeners = new Set<() => void>()
let snapshot: ProfileSnapshot = { status: 'idle', profile: null }
let pending: Promise<void> | null = null

function emit(next: ProfileSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): ProfileSnapshot {
  return snapshot
}

export function publishProfile(profile: AccountProfile): void {
  emit({ status: 'ready', profile })
}

export function clearAccountProfile(): void {
  pending = null
  emit({ status: 'idle', profile: null })
}

export function useAccountProfile(): ProfileSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 顶栏、菜单和面板读同一份。失败时留着上一份可用资料，避免头像闪回青芽。 */
export function loadAccountProfile(): Promise<void> {
  if (snapshot.status === 'idle') emit({ status: 'loading', profile: snapshot.profile })
  const run = fetchProfile()
    .then((profile) => {
      if (pending !== run) return
      emit({ status: 'ready', profile })
    })
    .catch(() => {
      if (pending !== run) return
      emit({ status: snapshot.profile ? 'ready' : 'error', profile: snapshot.profile })
    })
    .finally(() => {
      if (pending === run) pending = null
    })
  pending = run
  return run
}
