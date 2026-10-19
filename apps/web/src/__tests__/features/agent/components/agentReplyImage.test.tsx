// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AgentMarkdown from '../../../../features/agent/components/AgentMarkdown'
import { AgentReplyImagesProvider } from '../../../../features/agent/components/AgentReplyImage'
import type { AgentPanelMessage } from '../../../../features/agent/types'

const preview = vi.hoisted(() => vi.fn())
vi.mock('../../../../features/agent/lib/artifactPreview', () => ({
  INLINE_RESULT_THUMBNAIL_SCALE: 2.5,
  artifactPreview: preview,
}))

const generated = 'agent_11111111-2222-3333-4444-555555555555_0'
const mediaId = '99999999-8888-7777-6666-555555555555'
const message = {
  kind: 'tool',
  id: 'tool-message',
  turnId: 'turn',
  toolCallId: 'call',
  toolName: 'generateImage',
  title: '生成',
  status: 'succeeded',
  artifacts: [
    {
      artifactId: generated,
      media: 'image',
      taskId: 'task',
      outputIndex: 0,
      mime: 'image/png',
      width: 1536,
      height: 1024,
      mediaId,
    },
  ],
} as unknown as AgentPanelMessage

let cleanup = () => {}
afterEach(() => {
  cleanup()
  preview.mockReset()
})

async function render(text: string, onPreview = vi.fn()) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <AgentReplyImagesProvider messages={[message]} onPreview={onPreview}>
        <AgentMarkdown text={text} />
      </AgentReplyImagesProvider>,
    ),
  )
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  return host
}

it('shows conversation images referenced by id or media identity and opens the result preview', async () => {
  preview.mockResolvedValue({ source: 'blob:preview', onCanvas: false })
  const onPreview = vi.fn()
  const host = await render(
    `方向一\n\n![方向一效果图](${generated})\n\n方向二\n\n![方向二效果图](aip-media:${mediaId})`,
    onPreview,
  )
  const images = [...host.querySelectorAll('img')]
  expect(images.map((image) => [image.getAttribute('src'), image.alt])).toEqual([
    ['blob:preview', '方向一效果图'],
    ['blob:preview', '方向二效果图'],
  ])
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(onPreview).toHaveBeenCalledWith('tool-message', generated, 'blob:preview')
})

it('keeps only the caption for unknown or external image addresses', async () => {
  const host = await render(
    '![方向三效果图](方向三.png)\n\n![追踪](https://tracker.example/pixel.png)\n\n![旧图](agent_00000000-0000-0000-0000-000000000000_1)',
  )
  expect(host.querySelector('img')).toBeNull()
  expect(preview).not.toHaveBeenCalled()
  expect(host.textContent).toContain('[方向三效果图]')
  expect(host.textContent).toContain('[追踪]')
  expect(host.textContent).toContain('[旧图]')
})

it('falls back to the caption when the image cannot be loaded', async () => {
  preview.mockResolvedValue({ source: null, onCanvas: false })
  const host = await render(`![方向四效果图](${generated})`)
  expect(host.querySelector('img')).toBeNull()
  expect(host.textContent).toContain('[方向四效果图]')
})
