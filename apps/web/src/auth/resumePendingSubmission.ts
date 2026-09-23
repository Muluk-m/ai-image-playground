import { startCanvasFromComposer } from '../features/agent/lib/heroHandoff'
import { submitPrepared, useStore } from '../store'
import { isSignedIn } from './loginPrompt'
import { takePendingSubmission } from './pendingSubmission'

export async function resumePendingSubmission(): Promise<void> {
  if (!isSignedIn()) return
  const pending = await takePendingSubmission()
  if (!pending) return
  if (pending.kind === 'image') {
    const ids = await submitPrepared(pending.input)
    if (ids.length === 0 && !useStore.getState().prompt.trim()) {
      const { prompt, inputImages, params, slotValues } = pending.input
      useStore.setState({ prompt, inputImages, params, slotValues: slotValues ?? {} })
    }
  } else if (!(await startCanvasFromComposer(pending.draft))) {
    if (!useStore.getState().prompt.trim()) {
      useStore.setState({
        prompt: pending.draft.prompt,
        inputImages: pending.draft.references.map(({ id, dataUrl }) => ({ id, dataUrl })),
      })
    }
  }
}
