// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AgentCopyDiagnostic from '../../../../features/agent/components/AgentCopyDiagnostic'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('copies the original error and identifiers as inspectable JSON', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const diagnostic = { message: '400: unsupported model', requestId: 'request-1', turnId: 'turn-1' }
  try {
    act(() => root.render(<AgentCopyDiagnostic diagnostic={diagnostic} />))
    await act(async () => host.querySelector('button')!.click())
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(diagnostic)
    expect(host.textContent).toContain('已复制')
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
