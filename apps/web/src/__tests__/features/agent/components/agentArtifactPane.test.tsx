// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AgentArtifactPane from '../../../../features/agent/components/AgentArtifactPane'
import type { AgentToolMessage } from '../../../../features/agent/types'

const previewArtifactBitmap = vi.hoisted(() =>
  vi.fn(
    async (artifact: { artifactId: string }): Promise<string | null> =>
      `data:image/png;base64,${artifact.artifactId}`,
  ),
)
const canvas = vi.hoisted(() => ({
  has: vi.fn((_id: string) => false),
  thumbnail: vi.fn(async (_id: string) => 'data:image/png;base64,canvas'),
}))
vi.mock('../../../../features/agent/lib/artifactSource', () => ({ previewArtifactBitmap }))
vi.mock('../../../../features/agent/lib/canvasSink', () => ({ agentCanvasSink: () => canvas }))
vi.mock('../../../../components/Lightbox', () => ({
  ImagePreview: () => <div data-testid="zoomed" />,
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const message: AgentToolMessage = {
  kind: 'tool',
  id: 'result',
  turnId: 'turn',
  toolCallId: 'call',
  title: '两张城市夜景',
  status: 'succeeded',
  delivery: 'placed',
  artifacts: [
    { artifactId: 'first', taskId: 'task', outputIndex: 0, media: 'image', mime: 'image/png' },
    { artifactId: 'second', taskId: 'task', outputIndex: 1, media: 'image', mime: 'image/png' },
  ],
}

afterEach(() => {
  previewArtifactBitmap.mockClear()
  canvas.has.mockReset()
  canvas.has.mockReturnValue(false)
  canvas.thumbnail.mockClear()
})

it('previews, switches and enlarges results without entering the canvas', async () => {
  canvas.has.mockReturnValue(true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const onViewCanvas = vi.fn()
  const onClose = vi.fn()
  const onSelect = vi.fn()
  try {
    await act(async () =>
      root.render(
        <AgentArtifactPane
          message={message}
          onSelect={onSelect}
          onClose={onClose}
          onViewCanvas={onViewCanvas}
        />,
      ),
    )
    expect(
      document.body.querySelector('.studio-artifact-pane-image img')?.getAttribute('src'),
    ).toContain('first')
    expect(onViewCanvas).not.toHaveBeenCalled()

    act(() =>
      (
        document.body.querySelectorAll('.studio-artifact-pane-thumb')[1] as HTMLButtonElement
      ).click(),
    )
    expect(onSelect).toHaveBeenCalledWith('second')
    await act(async () =>
      root.render(
        <AgentArtifactPane
          message={message}
          selectedId="second"
          onSelect={onSelect}
          onClose={onClose}
          onViewCanvas={onViewCanvas}
        />,
      ),
    )
    expect(
      document.body.querySelector('.studio-artifact-pane-image img')?.getAttribute('src'),
    ).toContain('second')

    act(() =>
      (document.body.querySelector('.studio-artifact-pane-image') as HTMLButtonElement).click(),
    )
    expect(document.body.querySelector('[data-testid="zoomed"]')).not.toBeNull()
    act(() =>
      (document.body.querySelector('.studio-artifact-pane-edit') as HTMLButtonElement).click(),
    )
    expect(onViewCanvas).toHaveBeenCalledWith(['second'])
    act(() =>
      (
        document.body.querySelector('.studio-artifact-pane-tools button') as HTMLButtonElement
      ).click(),
    )
    expect(onViewCanvas).toHaveBeenCalledWith(['second'], 'inpaint')
    act(() =>
      (document.body.querySelector('.studio-artifact-pane-back') as HTMLButtonElement).click(),
    )
    expect(onClose).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
  }
})

it('uses the existing canvas bitmap when the original queue output is no longer available', async () => {
  canvas.has.mockReturnValue(true)
  previewArtifactBitmap.mockResolvedValueOnce(null)
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <AgentArtifactPane
          message={message}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onViewCanvas={vi.fn()}
        />,
      ),
    )
    expect(
      document.body.querySelector('.studio-artifact-pane-image img')?.getAttribute('src'),
    ).toContain('canvas')
    expect(canvas.thumbnail).toHaveBeenCalledWith('first', 3)
    expect(previewArtifactBitmap).toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
  }
})
