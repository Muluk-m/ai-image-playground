// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ModelChoice, ModelList } from '../../components/composer/ModelSelector'
import AgentCanvasHandoffDialog from '../../features/agent/components/AgentCanvasHandoffDialog'
import AgentClarification from '../../features/agent/components/AgentClarification'
import { useAgentStore } from '../../features/agent/store'
import CanvasBatchConfirmDialog from '../../features/canvas/components/CanvasBatchConfirmDialog'
import { useImageDropZone } from '../../hooks/useImageDropZone'
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

describe('UX Batch 5 — Workspace, Canvas & Agent', () => {
  it('ModelList ArrowDown skips unavailable options', async () => {
    const options: ModelChoice[] = [
      { value: 'p::a', model: 'a', profileId: 'p', label: 'Model A' },
      { value: 'p::b', model: 'b', profileId: 'p', label: 'Model B', unavailable: true },
      { value: 'p::c', model: 'c', profileId: 'p', label: 'Model C' },
    ]
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(<ModelList options={options} value="p::a" onPick={vi.fn()} />),
      )
      const listbox = host.querySelector<HTMLElement>('[role="listbox"]')!
      const items = [...host.querySelectorAll<HTMLElement>('[role="option"]')]
      items[0]!.focus()
      expect(document.activeElement).toBe(items[0])
      await act(async () => {
        listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
      expect(document.activeElement).toBe(items[2])
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('useImageDropZone suppresses drag highlight when disabled', async () => {
    const onFiles = vi.fn()
    function Harness({ disabled }: { disabled: boolean }) {
      const { dragging, dropZoneProps } = useImageDropZone(onFiles, { disabled })
      return <div data-testid="zone" data-dragging={dragging ? 'yes' : 'no'} {...dropZoneProps} />
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const dispatchDragEnter = (el: HTMLElement) => {
      const ev = new Event('dragenter', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'] } })
      el.dispatchEvent(ev)
    }
    try {
      await act(async () => root.render(<Harness disabled={true} />))
      const zone = host.querySelector<HTMLElement>('[data-testid="zone"]')!
      await act(async () => dispatchDragEnter(zone))
      expect(zone.getAttribute('data-dragging')).toBe('no')

      await act(async () => root.render(<Harness disabled={false} />))
      await act(async () => dispatchDragEnter(zone))
      expect(zone.getAttribute('data-dragging')).toBe('yes')

      await act(async () => root.render(<Harness disabled={true} />))
      expect(zone.getAttribute('data-dragging')).toBe('no')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('CanvasBatchConfirmDialog prevents double submit and stays open with toast on failure', async () => {
    const showToast = vi.fn()
    useStore.setState({ showToast })
    let rejectConfirm!: (err: Error) => void
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectConfirm = reject
        }),
    )
    const onClose = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <CanvasBatchConfirmDialog
            title="Batch cutout"
            note="Note"
            count={2}
            onConfirm={onConfirm}
            onClose={onClose}
          />,
        ),
      )
      const submitBtn = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('2'),
      )!
      await act(async () => {
        submitBtn.click()
        submitBtn.click()
      })
      expect(onConfirm).toHaveBeenCalledTimes(1)
      expect(submitBtn.getAttribute('aria-busy')).toBe('true')
      expect(submitBtn.disabled).toBe(true)

      await act(async () => {
        rejectConfirm(new Error('network down'))
        await Promise.resolve()
      })
      expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error')
      expect(onClose).not.toHaveBeenCalled()
      expect(submitBtn.disabled).toBe(false)
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('AgentCanvasHandoffDialog locks double click and clears aria-busy on failure', async () => {
    let resolveChoose!: (ok: boolean) => void
    const onChoose = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveChoose = resolve
        }),
    )
    const onClose = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <AgentCanvasHandoffDialog
            count={1}
            projects={[
              {
                id: 'proj-1',
                name: 'Canvas One',
                createdAt: 1,
                updatedAt: 1,
                experience: 'canvas',
              } as never,
            ]}
            onChoose={onChoose}
            onClose={onClose}
          />,
        ),
      )
      const existingBtn = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Canvas One'),
      )!
      await act(async () => {
        existingBtn.click()
        existingBtn.click()
      })
      expect(onChoose).toHaveBeenCalledTimes(1)
      expect(existingBtn.getAttribute('aria-busy')).toBe('true')

      await act(async () => {
        resolveChoose(false)
        await Promise.resolve()
      })
      expect(document.querySelector('[role="alert"]')).not.toBeNull()
      expect(existingBtn.getAttribute('aria-busy')).toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('AgentClarification locks double send on custom answer and guards IME keyCode 229', async () => {
    let resolveSend!: () => void
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        }),
    )
    useAgentStore.setState({ turn: 'idle', messages: [], send: send as never })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <AgentClarification
            message={
              {
                id: 'c1',
                kind: 'clarification',
                question: 'Pick style',
                options: ['Minimal', 'Bold'],
              } as never
            }
            answered={false}
          />,
        ),
      )
      const otherBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        /其他|Other/.test(b.textContent ?? ''),
      )!
      await act(async () => otherBtn.click())
      const input = host.querySelector<HTMLInputElement>('input')!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, 'Warm vintage')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })

      const imeEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
      Object.defineProperty(imeEvent, 'keyCode', { value: 229 })
      await act(async () => {
        input.dispatchEvent(imeEvent)
      })
      expect(imeEvent.defaultPrevented).toBe(true)

      const form = input.closest('form')!
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith('Warm vintage')
      expect(input.disabled).toBe(true)

      await act(async () => {
        resolveSend()
        await Promise.resolve()
      })
      expect(input.disabled).toBe(false)
    } finally {
      await act(async () => root.unmount())
    }
  })
})
