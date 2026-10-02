import { useStore } from '../store'
import { accountScope } from './authScope'

export interface SubmissionContextWatch {
  isCurrent: () => boolean
  dispose: () => void
}

/**
 * A submission belongs to the account, page and composer target it started in. Leaving any of
 * them is final: coming back later does not revive the old request.
 */
export function watchSubmissionContext(
  sourcePath?: string,
  onLeave?: () => void,
): SubmissionContextWatch {
  const sameAccount = accountScope()
  const start = useStore.getState()
  let left = false
  const matches = () =>
    sameAccount() &&
    (!sourcePath || window.location.pathname === sourcePath) &&
    useStore.getState().appMode === start.appMode &&
    useStore.getState().createTarget === start.createTarget
  const check = () => {
    if (left || matches()) return
    left = true
    onLeave?.()
  }
  const unsubscribe = useStore.subscribe(check)
  window.addEventListener('popstate', check)
  return {
    isCurrent: () => !left && matches(),
    dispose: () => {
      unsubscribe()
      window.removeEventListener('popstate', check)
    },
  }
}
