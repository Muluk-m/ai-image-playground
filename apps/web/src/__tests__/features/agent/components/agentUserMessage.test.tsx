// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentUserMessage from '../../../../features/agent/components/AgentUserMessage'
import * as agentClient from '../../../../features/agent/lib/agentClient'
import { useAgentStore } from '../../../../features/agent/store'
import type { AgentTextMessage } from '../../../../features/agent/types'

vi.mock('../../../../components/Lightbox', () => ({
  ImagePreview: ({ src }: { src: string }) => <img data-original src={src} alt="原图" />,
}))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAgentStore.setState({ conversationId: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([
  'aip-local',
  'aip-media',
  'mediaId',
])('已发送的 %s 引用从消息读取缩略图，点开时才读取原图', async (kind) => {
  useAgentStore.setState({ conversationId: 'conversation-1' })
  const id = crypto.randomUUID()
  const thumbnail = new Blob(['thumbnail'], { type: 'image/webp' })
  const original = new Blob(['original'], { type: 'image/png' })
  const fetchReference = vi
    .spyOn(agentClient, 'fetchMessageReference')
    .mockResolvedValueOnce(thumbnail)
    .mockResolvedValueOnce(original)
  const createUrl = vi.fn((blob: Blob) => (blob === thumbnail ? 'blob:thumbnail' : 'blob:original'))
  const revokeUrl = vi.fn()
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }),
  )
  const message: AgentTextMessage = {
    kind: 'text',
    id: 'user-1',
    turnId: 'turn-1',
    role: 'user',
    streaming: false,
    text: '加背景',
    references: [
      {
        imageId: 'photo',
        name: '产品图',
        ...(kind === 'mediaId' ? { mediaId: id } : { dataUrl: `${kind}:${id}` }),
      },
    ],
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentUserMessage message={message} skills={[]} />))
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:thumbnail')
    expect(fetchReference).toHaveBeenCalledTimes(1)
    expect(fetchReference).toHaveBeenNthCalledWith(1, 'conversation-1', 'user-1', 0, {
      signal: expect.any(AbortSignal),
    })

    await act(async () => host.querySelector<HTMLButtonElement>('.agent-image-mention')!.click())
    expect(host.querySelector('[data-original]')?.getAttribute('src')).toBe('blob:original')
    expect(fetchReference).toHaveBeenNthCalledWith(2, 'conversation-1', 'user-1', 0, {
      signal: expect.any(AbortSignal),
      variant: 'annotated',
    })
  } finally {
    act(() => root.unmount())
  }
  expect(revokeUrl.mock.calls.flat()).toEqual(['blob:thumbnail', 'blob:original'])
})

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

it('folds reference chips past the first row and expands them on request', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const message: AgentTextMessage = {
    kind: 'text',
    id: 'user',
    turnId: 'turn',
    role: 'user',
    streaming: false,
    text: '优化一下背景',
    references: Array.from({ length: 12 }, (_, index) => ({
      imageId: `img-${index}`,
      name: `图${index + 1}`,
      image: { object: `image-${index}`, mime: 'image/png' },
    })),
  }
  try {
    act(() => root.render(<AgentUserMessage message={message} skills={[]} />))
    expect(host.querySelectorAll('.agent-image-mention')).toHaveLength(8)
    expect(host.textContent).toContain('@图8')
    expect(host.textContent).not.toContain('@图9')
    const fold = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('还有 4 张'),
    )
    expect(fold?.getAttribute('aria-expanded')).toBe('false')
    act(() => fold?.click())
    expect(host.querySelectorAll('.agent-image-mention')).toHaveLength(12)
    expect(host.textContent).toContain('@图12')
    const collapse = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('收起'),
    )
    expect(collapse?.getAttribute('aria-expanded')).toBe('true')
    act(() => collapse?.click())
    expect(host.querySelectorAll('.agent-image-mention')).toHaveLength(8)
    expect(host.textContent).not.toContain('@图9')
  } finally {
    act(() => root.unmount())
  }
})

it('keeps a narrow panel on one row when reference names are long', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 340,
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  const message: AgentTextMessage = {
    kind: 'text',
    id: 'user',
    turnId: 'turn',
    role: 'user',
    streaming: false,
    text: '优化一下背景',
    references: Array.from({ length: 12 }, (_, index) => ({
      imageId: `img-${index}`,
      name: `微信图片_20261008_${index + 1}`,
      image: { object: `image-${index}`, mime: 'image/png' },
    })),
  }
  try {
    act(() => root.render(<AgentUserMessage message={message} skills={[]} />))
    expect(host.querySelectorAll('.agent-image-mention').length).toBeLessThan(8)
    const fold = host.querySelector<HTMLButtonElement>('.agent-reference-fold')
    expect(fold?.getAttribute('aria-expanded')).toBe('false')
    expect(fold?.textContent ?? '').toMatch(/还有 \d+ 张|12 张参考图/)
    act(() => fold?.click())
    expect(host.querySelectorAll('.agent-image-mention')).toHaveLength(12)
    expect(host.textContent).toContain('收起')
  } finally {
    act(() => root.unmount())
    if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original)
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  }
})
