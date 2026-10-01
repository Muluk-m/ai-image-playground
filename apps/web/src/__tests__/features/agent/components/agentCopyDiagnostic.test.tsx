// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AgentCopyDiagnostic from '../../../../features/agent/components/AgentCopyDiagnostic'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('shows readable error fields and copies either details or the unchanged original JSON', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const diagnostic = {
    code: 'agent_upstream_error',
    message: 'Original upstream error detail was not recorded by this version.',
    occurredAt: '2026-09-30T04:31:34.969+00:00',
    durationMs: 62,
    requestId: 'request-1',
    turnId: 'turn-1',
    extra: 'preserved',
  }
  try {
    act(() => root.render(<AgentCopyDiagnostic diagnostic={diagnostic} />))
    act(() => host.querySelector('button')!.click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('这条旧记录未保存原始错误详情')
    expect(dialog.querySelector('dl')!.textContent).toContain('62 ms')
    expect(dialog.querySelector('dl')!.textContent).not.toContain('2026-09-30T04:31:34')
    expect(dialog.querySelector('details')!.open).toBe(false)
    const button = (label: string) =>
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === label)!
    await act(async () => button('复制详情').click())
    expect(writeText.mock.calls[0]![0]).toContain('请求 ID: request-1')
    expect(writeText.mock.calls[0]![0]).toContain('耗时: 62 ms')
    expect(writeText.mock.calls[0]![0]).toContain('"extra": "preserved"')
    await act(async () => button('复制原始日志').click())
    expect(JSON.parse(writeText.mock.calls[1]![0])).toEqual(diagnostic)
    expect(dialog.textContent).toContain('已复制')
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
