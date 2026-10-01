import { startCanvasFromComposer } from '../features/agent/lib/heroHandoff'
import { beginLookSubmission } from '../features/library/lib/lookSubmissionOperation'
import { i18next } from '../i18n'
import { accountScope, scopedStorageName } from '../lib/authScope'
import { submitPrepared, useStore } from '../store'
import { isSignedIn } from './loginPrompt'
import { takePendingSubmission } from './pendingSubmission'

export async function resumePendingSubmission(): Promise<void> {
  if (!isSignedIn()) return
  const pending = await takePendingSubmission()
  if (!pending) return
  if (pending.sourcePath && window.location.pathname !== pending.sourcePath) return
  if (pending.kind === 'image') {
    if (pending.ownerScope && pending.ownerScope !== scopedStorageName('pending')) return
    if (pending.template) {
      const operation = beginLookSubmission()
      if (!operation) return
      try {
        await operation.wait(
          submitPrepared(pending.input, {
            signal: operation.signal,
            isCurrent: operation.isCurrent,
            onConfirmationPending: operation.setConfirmationPending,
          }),
        )
      } catch {
        if (!operation.signal.aborted || operation.signal.reason?.name === 'TimeoutError')
          useStore.getState().showToast(i18next.t('look.prepareFailed', { ns: 'library' }), 'error')
      } finally {
        operation.finish()
      }
      return
    }
    const sameAccount = accountScope()
    const start = useStore.getState()
    let active = true
    const current = () =>
      active &&
      sameAccount() &&
      (!pending.sourcePath || window.location.pathname === pending.sourcePath)
    const unwatch = useStore.subscribe((next) => {
      if (next.appMode !== start.appMode || next.createTarget !== start.createTarget) active = false
    })
    const onNavigate = () => {
      if (!current()) active = false
    }
    window.addEventListener('popstate', onNavigate)
    let ids: string[]
    try {
      ids = await submitPrepared(pending.input, { isCurrent: current })
    } finally {
      unwatch()
      window.removeEventListener('popstate', onNavigate)
    }
    if (!current()) return
    if (
      ids.length === 0 &&
      !useStore.getState().prompt.trim() &&
      useStore.getState().inputImages === start.inputImages &&
      useStore.getState().params === start.params &&
      useStore.getState().slotValues === start.slotValues
    ) {
      const { prompt, inputImages, params, slotValues } = pending.input
      useStore.setState({ prompt, inputImages, params, slotValues: slotValues ?? {} })
    }
  } else if (!(await startCanvasFromComposer(pending.draft, pending.experience ?? 'canvas'))) {
    if (!useStore.getState().prompt.trim()) {
      useStore.setState({
        createTarget: pending.experience ?? 'canvas',
        prompt: pending.draft.prompt,
        inputImages: pending.draft.references.map(({ id, dataUrl }) => ({ id, dataUrl })),
      })
    }
  }
}
