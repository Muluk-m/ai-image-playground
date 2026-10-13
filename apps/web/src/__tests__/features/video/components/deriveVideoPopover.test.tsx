// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DeriveVideoPopover from '../../../../features/video/components/DeriveVideoPopover'

const guard = vi.hoisted(() => ({
  blocked: false,
  disabledReason: undefined as string | undefined,
}))
vi.mock('../../../../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/privateOverlay')>()),
  usePrivateSubmissionGuard: () => guard,
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  guard.blocked = false
  guard.disabledReason = undefined
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('allows closing a blocked derivation without submitting it', () => {
  guard.blocked = true
  const onSubmit = vi.fn(async () => true)
  const onClose = vi.fn()
  act(() =>
    root.render(
      <DeriveVideoPopover
        sourceSeconds={8}
        mode="edit"
        modelId="grok-imagine-video"
        initialPrompt="保留镜头运动"
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    ),
  )
  const dialog = document.querySelector('[role="dialog"]')!
  const close = dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!
  expect(close).not.toBeNull()
  expect(close.disabled).toBe(false)
  expect(dialog.querySelector<HTMLButtonElement>('button:disabled')).not.toBeNull()
  act(() => close.click())
  expect(onClose).toHaveBeenCalledOnce()
  expect(onSubmit).not.toHaveBeenCalled()
})

it('preserves edit duration and stays open until the submission is accepted', async () => {
  const onSubmit = vi.fn(async () => false)
  const onClose = vi.fn()
  act(() =>
    root.render(
      <DeriveVideoPopover
        sourceSeconds={8}
        mode="edit"
        modelId="grok-imagine-video"
        initialPrompt="保留镜头运动"
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    ),
  )
  const submit = document.querySelector<HTMLButtonElement>(
    '[role="dialog"] button:not([aria-label])',
  )!
  await act(async () => submit.click())
  expect(onSubmit).toHaveBeenLastCalledWith({ mode: 'edit', prompt: '保留镜头运动', seconds: 8 })
  expect(onClose).not.toHaveBeenCalled()
  onSubmit.mockResolvedValueOnce(true)
  await act(async () => submit.click())
  expect(onClose).toHaveBeenCalledOnce()
})
