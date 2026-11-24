import { useCallback, useEffect, useState } from 'react'

export const SEEN_FEATURES_KEY = 'aip.seenFeatures'
const CHANGE_EVENT = 'aip:seen-features'

export interface FeatureDiscoveryEntry {
  /** 父入口分组名：用于给下拉选择器、导航栏等父级入口统一挂绿点。 */
  readonly group: 'composer-mode'
  /** 本地日期（YYYY-MM-DD）；过了这一天（次日 00:00 起）绿点与 NEW 徽标自动退役。 */
  readonly until: string
}

/**
 * 新功能发现注册表：以后上线新模式、新参数、新工具只需加一条。
 * - 父级入口用 `useGroupHasNew(group)` 控制右上角芽绿点；任一未看过且未过期子项存在即亮。
 * - 列表项用 `useFeatureNew(id)` 控制右侧 `NEW` 徽标与点选消隐。
 */
export const FEATURE_DISCOVERY_REGISTRY = {
  'composer.batchMode': {
    group: 'composer-mode',
    until: '2026-12-31',
  },
} as const satisfies Record<string, FeatureDiscoveryEntry>

export type FeatureDiscoveryId = keyof typeof FEATURE_DISCOVERY_REGISTRY
export type FeatureDiscoveryGroup = FeatureDiscoveryEntry['group']

function parseExpiryMs(until: string): number {
  // 按当天结束（次日 00:00 本地时间）判定过期。
  const [year, month, day] = until.split('-').map(Number)
  if (!year || !month || !day) return 0
  return new Date(year, month - 1, day + 1).getTime()
}

export function isFeatureWithinWindow(id: FeatureDiscoveryId, now: number = Date.now()): boolean {
  const entry = FEATURE_DISCOVERY_REGISTRY[id]
  return now < parseExpiryMs(entry.until)
}

export function readSeenFeatures(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(SEEN_FEATURES_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

export function isFeatureUnseen(
  id: FeatureDiscoveryId,
  seen: ReadonlySet<string> = readSeenFeatures(),
  now: number = Date.now(),
): boolean {
  return isFeatureWithinWindow(id, now) && !seen.has(id)
}

export function groupHasUnseenFeature(
  group: FeatureDiscoveryGroup,
  seen: ReadonlySet<string> = readSeenFeatures(),
  now: number = Date.now(),
): boolean {
  for (const id of Object.keys(FEATURE_DISCOVERY_REGISTRY) as FeatureDiscoveryId[]) {
    if (FEATURE_DISCOVERY_REGISTRY[id].group === group && isFeatureUnseen(id, seen, now)) {
      return true
    }
  }
  return false
}

export function markFeatureSeen(id: FeatureDiscoveryId): void {
  const seen = new Set(readSeenFeatures())
  if (seen.has(id)) return
  seen.add(id)
  try {
    localStorage.setItem(SEEN_FEATURES_KEY, JSON.stringify([...seen]))
  } catch {
    // Storage can be unavailable in private browsing; in-memory listeners still update.
  }
  window.dispatchEvent(new CustomEvent<ReadonlySet<string>>(CHANGE_EVENT, { detail: seen }))
}

function useSeenFeatures(): ReadonlySet<string> {
  const [seen, setSeen] = useState<ReadonlySet<string>>(readSeenFeatures)
  useEffect(() => {
    const onLocal = (event: Event) => setSeen((event as CustomEvent<ReadonlySet<string>>).detail)
    const onStorage = (event: StorageEvent) => {
      if (event.key === SEEN_FEATURES_KEY || event.key === null) setSeen(readSeenFeatures())
    }
    window.addEventListener(CHANGE_EVENT, onLocal)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onLocal)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return seen
}

/** 父级入口是否有未看过的新功能（用于控制右上角芽绿点）。 */
export function useGroupHasNew(group: FeatureDiscoveryGroup): boolean {
  const seen = useSeenFeatures()
  return groupHasUnseenFeature(group, seen)
}

/** 单个新功能的引导状态：`dot` 看过即灭，`badge` 在上线窗口内保留。 */
export function useFeatureNew(id: FeatureDiscoveryId): {
  readonly dot: boolean
  readonly badge: boolean
  readonly markSeen: () => void
} {
  const seen = useSeenFeatures()
  const markSeen = useCallback(() => markFeatureSeen(id), [id])
  const withinWindow = isFeatureWithinWindow(id)
  return {
    dot: withinWindow && !seen.has(id),
    badge: withinWindow,
    markSeen,
  }
}
