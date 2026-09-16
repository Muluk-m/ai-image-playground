// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
it('keeps the complete multiline prompt available and copies it without the title truncation', async () => {
  const prompt = '完整提示词。'.repeat(30) + '\n第二段细节'
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() =>
      root.render(
        <AgentToolCard
          message={{
            kind: 'tool',
            id: 'm',
            turnId: 't',
            toolCallId: 'c',
            title: '摘要…',
            prompt,
            status: 'running',
          }}
        />,
      ),
    )
    expect(host.textContent).not.toContain('复制')
    expect(host.textContent).not.toContain('存为模板')
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('[aria-label="完整提示词"]')?.textContent).toBe(prompt)
    const copy = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === '复制',
    )!
    await act(async () => copy.click())
    expect(writeText).toHaveBeenCalledWith(prompt)
    expect(dialog.textContent).toContain('已复制')
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭提示词"]')!.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
