// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AgentArtifactPane from '../../../../features/agent/components/AgentArtifactPane'
import type { AgentToolMessage } from '../../../../features/agent/types'
import { stubPointerApis } from '../../../helpers/radix'

vi.mock('../../../../lib/authClient', () => ({
  authenticatedBffFetch: vi.fn(
    async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }),
  ),
}))
vi.mock('../../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://test.local' }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
it('embeds the real preview and editor in the production panel and navigates only on explicit canvas action', async () => {
  stubPointerApis()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onViewCanvas = vi.fn()
  const onClose = vi.fn()
  const message: AgentToolMessage = {
    kind: 'tool',
    id: 'panel-result',
    turnId: 'turn',
    toolCallId: 'call',
    title: '角色',
    status: 'succeeded',
    artifacts: [
      {
        artifactId: 'panel-image',
        taskId: 'panel-task',
        outputIndex: 0,
        mime: 'image/png',
        media: 'image',
      },
    ],
  }
  try {
    await act(async () =>
      root.render(
        <div className="production-workspace">
          <input aria-label="Chat" defaultValue="继续这个角色" />
          <AgentArtifactPane
            presentation="panel"
            message={message}
            onSelect={() => {}}
            onClose={onClose}
            onViewCanvas={onViewCanvas}
          />
        </div>,
      ),
    )
    const pane = host.querySelector<HTMLElement>('.studio-artifact-pane')
    expect(pane).not.toBeNull()
    expect(pane?.parentElement?.className).toBe('production-workspace')
    expect(pane?.getAttribute('aria-modal')).not.toBe('true')
    expect(pane?.querySelector('img')?.getAttribute('src')).toContain('data:image/png')
    await act(async () =>
      Array.from(pane!.querySelectorAll('button'))
        .find((button) => button.textContent === '裁剪')!
        .click(),
    )
    const editor = pane!.querySelector<HTMLElement>('.studio-artifact-edit-dialog')
    expect(editor).not.toBeNull()
    expect(onViewCanvas).not.toHaveBeenCalled()
    await act(async () =>
      editor!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    )
    expect(pane!.querySelector('.studio-artifact-edit-dialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(host.querySelector('input')?.value).toBe('继续这个角色')
    await act(async () =>
      pane!.querySelector<HTMLButtonElement>('.studio-artifact-pane-edit')!.click(),
    )
    expect(onViewCanvas).toHaveBeenCalledExactlyOnceWith(['panel-image'])
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
