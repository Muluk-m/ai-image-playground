// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentConfirmationGate from '../../features/agent/components/AgentConfirmationGate'
import { useAgentStore } from '../../features/agent/store'
import ScriptBriefDialog from '../../features/canvas/components/ScriptBriefDialog'
import DeriveVideoPopover from '../../features/video/components/DeriveVideoPopover'
import { useStore } from '../../store'
import { stubPointerApis } from '../helpers/radix'

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  stubPointerApis()
  useStore.setState({ confirmDialog: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ScriptBriefDialog unsaved close guard', () => {
  it('asks for confirmation before discarding unsaved edits on Cancel', async () => {
    const onClose = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(<ScriptBriefDialog onClose={onClose} onConfirm={vi.fn()} />),
      )
      const input = document.querySelector<HTMLInputElement>('input')!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, '修改后的剧本标题')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const cancelBtn = [...document.querySelectorAll('button')].find(
        (b) => b.textContent === '取消',
      )!
      await act(async () => cancelBtn.click())
      expect(onClose).not.toHaveBeenCalled()
      expect(useStore.getState().confirmDialog).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  })
})

describe('DeriveVideoPopover submitting close guard', () => {
  it('ignores Escape while submission is in flight', async () => {
    const onClose = vi.fn()
    let resolveSubmit!: (ok: boolean) => void
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSubmit = resolve
        }),
    )
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <DeriveVideoPopover
            sourceSeconds={5}
            mode="extend"
            modelId="grok-imagine-video-1.5-lite"
            initialPrompt="continue camera pan"
            onSubmit={onSubmit}
            onClose={onClose}
          />,
        ),
      )
      const buttons = [...document.querySelectorAll('button')]
      const submitBtn = buttons[buttons.length - 1]!
      await act(async () => submitBtn.click())
      expect(onSubmit).toHaveBeenCalledTimes(1)

      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      expect(onClose).not.toHaveBeenCalled()

      await act(async () => resolveSubmit(true))
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
    }
  })
})

describe('AgentConfirmationGate rejection recovery', () => {
  it('clears submitting lock and shows failure if confirmAllPrompts rejects', async () => {
    vi.spyOn(useAgentStore.getState(), 'confirmAllPrompts').mockRejectedValueOnce(
      new Error('network fail'),
    )
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <AgentConfirmationGate
            pending={[{ kind: 'draft', messageId: 'm1' }]}
            onJump={vi.fn()}
            onSendAnyway={vi.fn()}
          />,
        ),
      )
      const confirmBtn = document.querySelector<HTMLButtonElement>('button')!
      await act(async () => confirmBtn.click())
      await act(async () => Promise.resolve())
      expect(confirmBtn.disabled).toBe(false)
      expect(document.querySelector('[role="alert"]')).toBeTruthy()
    } finally {
      await act(async () => root.unmount())
    }
  })
})
