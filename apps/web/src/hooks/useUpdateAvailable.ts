import { useCallback, useEffect, useState } from 'react'
import { checkForUpdate, writeSkippedVersion } from '../lib/appUpdate'

const POLL_INTERVAL_MS = 10 * 60 * 1000
const REFOCUS_MIN_GAP_MS = 60 * 1000

export function useUpdateAvailable(): {
  availableVersion: string | null
  skip: () => void
} {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let lastCheckedAt = 0

    const check = () => {
      lastCheckedAt = Date.now()
      void checkForUpdate().then((version) => {
        if (!cancelled && version) setAvailableVersion(version)
      })
    }

    check()
    // 后台标签页不轮询：清单是 no-store，每次 tick 都是一次真实回源，而看不见的
    // 页面上提示条也没人看。重新可见时 REFOCUS_MIN_GAP_MS 已过，立刻补一次。
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') check()
    }, POLL_INTERVAL_MS)

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastCheckedAt < REFOCUS_MIN_GAP_MS) return
      check()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const skip = useCallback(() => {
    if (availableVersion) writeSkippedVersion(availableVersion)
    setAvailableVersion(null)
  }, [availableVersion])

  return { availableVersion, skip }
}
