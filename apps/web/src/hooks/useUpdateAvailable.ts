import { useCallback, useEffect, useState } from 'react'
import { type UpdateChecker, writeSkippedVersion } from '../lib/appUpdate'

const POLL_INTERVAL_MS = 10 * 60 * 1000

/** 窗口频繁切来切去时不重复拉清单。 */
const REFOCUS_MIN_GAP_MS = 60 * 1000

export function useUpdateAvailable(checker: UpdateChecker): {
  availableVersion: string | null
  skip: () => void
} {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let lastCheckedAt = 0

    const check = () => {
      lastCheckedAt = Date.now()
      void checker().then((version) => {
        if (!cancelled && version) setAvailableVersion(version)
      })
    }

    check()
    const timer = setInterval(check, POLL_INTERVAL_MS)

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
  }, [checker])

  const skip = useCallback(() => {
    if (availableVersion) writeSkippedVersion(availableVersion)
    setAvailableVersion(null)
  }, [availableVersion])

  return { availableVersion, skip }
}
