import { create } from 'zustand'
import {
  consumePendingLoginNavigation,
  discardPendingSubmission,
  subscribePendingSubmissionRemoval,
} from '../../../auth/pendingSubmission'
import { isUserStorageScope, scopedStorageName } from '../../../lib/authScope'
import { watchSubmissionContext } from '../../../lib/submissionContext'
import { useStore } from '../../../store'
import { useActiveLook } from './activeLook'

export const useLookSubmission = create<{ submitting: boolean }>(() => ({ submitting: false }))

interface LookSubmissionOperation {
  id: string
  signal: AbortSignal
  sourcePath: string
  ownerScope?: string
  isCurrent: () => boolean
  isEdited: () => boolean
  markPending: () => void
  setConfirmationPending: (pending: boolean) => void
  wait: <T>(work: Promise<T>) => Promise<T>
  finish: () => void
  cancel: () => void
}
let active: LookSubmissionOperation | null = null

export function cancelLookSubmission(): void {
  active?.cancel()
}

/** Initial submission and login resumption share the same cancellable preparation lifetime. */
export function beginLookSubmission(): LookSubmissionOperation | null {
  if (useLookSubmission.getState().submitting) return null
  cancelLookSubmission()
  const sourcePath = window.location.pathname
  const controller = new AbortController()
  let edited = false
  let pending = false
  const context = watchSubmissionContext(sourcePath, () => {
    if (active === operation) operation.cancel()
  })
  const current = () => !controller.signal.aborted && context.isCurrent()
  let remainingMs = 30_000
  let timerStartedAt = Date.now()
  let confirming = false
  const armTimeout = () =>
    setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), remainingMs)
  let timeout = armTimeout()
  const unwatch = useStore.subscribe((next, prev) => {
    if (
      next.prompt !== prev.prompt ||
      next.inputImages !== prev.inputImages ||
      next.params !== prev.params ||
      next.maskDraft !== prev.maskDraft ||
      next.slotValues !== prev.slotValues ||
      next.settings !== prev.settings
    )
      edited = true
  })
  const unwatchLook = useActiveLook.subscribe((next, prev) => {
    if (next.look !== prev.look) edited = true
  })
  const unwatchPending = subscribePendingSubmissionRemoval((id) => {
    if (id !== operation.id || active !== operation) return
    pending = false
    operation.cancel()
  })
  const onPageHide = () => {
    if (!pending || !consumePendingLoginNavigation(operation.id)) operation.cancel()
  }
  window.addEventListener('pagehide', onPageHide)
  const cleanup = () => {
    clearTimeout(timeout)
    unwatch()
    unwatchLook()
    unwatchPending()
    context.dispose()
    window.removeEventListener('pagehide', onPageHide)
  }
  const operation: LookSubmissionOperation = {
    id: crypto.randomUUID(),
    signal: controller.signal,
    sourcePath,
    ownerScope: isUserStorageScope() ? scopedStorageName('pending') : undefined,
    isCurrent: current,
    setConfirmationPending: (waiting) => {
      if (waiting === confirming) return
      confirming = waiting
      if (waiting) {
        remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt))
        clearTimeout(timeout)
      } else if (!controller.signal.aborted) {
        timerStartedAt = Date.now()
        timeout = armTimeout()
      }
    },
    isEdited: () => edited,
    markPending: () => {
      pending = true
    },
    wait: <T>(work: Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        const abort = () => reject(controller.signal.reason)
        if (controller.signal.aborted) {
          reject(controller.signal.reason)
          return
        }
        controller.signal.addEventListener('abort', abort, { once: true })
        work
          .then(resolve, reject)
          .finally(() => controller.signal.removeEventListener('abort', abort))
      }),
    cancel: () => {
      controller.abort()
      cleanup()
      if (active === operation) {
        active = null
        useLookSubmission.setState({ submitting: false })
      }
      if (pending) void discardPendingSubmission(operation.id).catch(() => {})
    },
    finish: () => {
      clearTimeout(timeout)
      if (!pending) cleanup()
      if (active === operation) {
        if (!pending) active = null
        useLookSubmission.setState({ submitting: false })
      }
    },
  }
  active = operation
  useLookSubmission.setState({ submitting: true })
  return operation
}
