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
    expect(host.querySelector('details p')?.textContent).toBe(prompt)
    expect(host.querySelector('summary')?.textContent).toBe('查看完整提示词')
    await act(async () => host.querySelector<HTMLButtonElement>('details button')!.click())
    expect(writeText).toHaveBeenCalledWith(prompt)
    expect(host.textContent).toContain('已复制')
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
