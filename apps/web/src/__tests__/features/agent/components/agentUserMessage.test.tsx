// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import AgentUserMessage from '../../../../features/agent/components/AgentUserMessage'
import type { AgentTextMessage } from '../../../../features/agent/types'

it('shows user intent and a named reference while hiding legacy edit scaffolding only for masked messages', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const text = '请根据附图的标注区域进行局部重绘，未标注区域保持原样。\n换成 xm'
  const message: AgentTextMessage = {
    kind: 'text',
    id: 'user',
    turnId: 'turn',
    role: 'user',
    streaming: false,
    text,
    references: [
      {
        imageId: 'phone',
        name: '手机海报',
        image: { object: 'image', mime: 'image/png' },
        mask: { object: 'mask', mime: 'image/png' },
      },
    ],
  }
  try {
    act(() => root.render(<AgentUserMessage message={message} skills={[]} />))
    expect(host.querySelector('.studio-agent-user-message')?.textContent).toBe('换成 xm')
    expect(host.querySelector('.agent-image-mention')?.textContent).toBe('@手机海报')
    act(() =>
      root.render(<AgentUserMessage message={{ ...message, references: [] }} skills={[]} />),
    )
    expect(host.querySelector('.studio-agent-user-message')?.textContent).toBe(text)
  } finally {
    act(() => root.unmount())
  }
})
