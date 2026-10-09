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
const resolveMediaSource = vi.hoisted(() =>
  vi.fn<(source: string, variant: string, urgent?: boolean) => Promise<string>>(),
)
vi.mock('../../../../lib/cloudMedia', () => ({ resolveMediaSource }))
const canvas = vi.hoisted(() => ({
  has: vi.fn((_id: string) => false),
  thumbnail: vi.fn(async (_id: string) => 'data:image/png;base64,canvas'),
}))
const send = vi.hoisted(() =>
  vi.fn(async (_text: string, _references: unknown, accepted?: () => void) => accepted?.()),
)
vi.mock('../../../../features/agent/lib/artifactSource', () => ({ previewArtifactBitmap }))
vi.mock('../../../../features/agent/lib/canvasSink', () => ({ agentCanvasSink: () => canvas }))
vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: { getState: () => ({ historyLoading: false, historyFailed: false, send }) },
}))
vi.mock('../../../../features/agent/components/AgentArtifactEditDialog', () => ({
  default: ({
    action,
    onClose,
    onGenerate,
  }: {
    action: string
    onClose: () => void
    onGenerate: (input: { dataUrl: string; maskDataUrl: string }, instruction: string) => void
  }) => (
    <div data-testid="edit-dialog">
      {action}
      <button onClick={onClose}>Close</button>
      <button
        onClick={() =>
          onGenerate(
            { dataUrl: 'data:image/png;base64,edited', maskDataUrl: 'data:image/png;base64,mask' },
            '加一盏灯',
          )
        }
      >
        Generate
      </button>
    </div>
  ),
}))
vi.mock('../../../../components/Lightbox', () => ({
  ImagePreview: ({ originalPending }: { originalPending?: boolean }) => (
    <div data-testid="zoomed" data-original-pending={originalPending} />
  ),
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
  resolveMediaSource.mockReset()
  canvas.has.mockReset()
  canvas.has.mockReturnValue(false)
  canvas.thumbnail.mockClear()
  send.mockClear()
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
    expect(document.body.querySelector('[data-testid="edit-dialog"]')?.textContent).toContain(
      'inpaint',
    )
    expect(onViewCanvas).toHaveBeenCalledTimes(1)
    await act(async () =>
      (
        document.body.querySelector(
          '[data-testid="edit-dialog"] button:last-child',
        ) as HTMLButtonElement
      ).click(),
    )
    expect(send).toHaveBeenCalledWith(
      '加一盏灯',
      [
        {
          imageId: 'second',
          name: message.title,
          editAction: 'inpaint',
          dataUrl: 'data:image/png;base64,edited',
          maskDataUrl: 'data:image/png;base64,mask',
        },
      ],
      expect.any(Function),
      'image',
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

it('keeps all image edit shortcuts in the Agent edit dialog', async () => {
  canvas.has.mockReturnValue(true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const onViewCanvas = vi.fn()
  try {
    await act(async () =>
      root.render(
        <AgentArtifactPane
          message={message}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onViewCanvas={onViewCanvas}
        />,
      ),
    )
    for (const action of ['inpaint', 'erase', 'crop', 'outpaint']) {
      const button = document.body.querySelectorAll('.studio-artifact-pane-tools button')[
        ['inpaint', 'erase', 'crop', 'outpaint'].indexOf(action)
      ] as HTMLButtonElement
      act(() => button.click())
      expect(document.body.querySelector('[data-testid="edit-dialog"]')?.textContent).toContain(
        action,
      )
      act(() =>
        (
          document.body.querySelector('[data-testid="edit-dialog"] button') as HTMLButtonElement
        ).click(),
      )
    }
    expect(onViewCanvas).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
  }
})

it('keeps the preview open when a higher dialog consumes Escape', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const onClose = vi.fn()
  const consumeEscape = (event: KeyboardEvent) => event.preventDefault()
  window.addEventListener('keydown', consumeEscape)
  try {
    await act(async () =>
      root.render(
        <AgentArtifactPane
          message={message}
          onSelect={vi.fn()}
          onClose={onClose}
          onViewCanvas={vi.fn()}
        />,
      ),
    )
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    )
    expect(onClose).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('keydown', consumeEscape)
    act(() => root.unmount())
  }
})

it('keeps chat result actions inside the conversation when no canvas callback is supplied', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(<AgentArtifactPane message={message} onSelect={vi.fn()} onClose={vi.fn()} />),
    )
    expect(document.body.querySelector('.studio-artifact-pane-canvas-action')).toBeNull()
    expect(document.body.textContent).toContain('局部重绘')
    expect(document.body.textContent).toContain('下载')
    expect(document.body.textContent).not.toContain('在画布中编辑')
  } finally {
    act(() => root.unmount())
  }
})

it('shows the existing result while the original is delayed and upgrades when it arrives', async () => {
  canvas.has.mockReturnValue(true)
  let resolveOriginal!: (value: string | null) => void
  previewArtifactBitmap.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOriginal = resolve
      }),
  )
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () =>
      root.render(
        <AgentArtifactPane
          message={{ ...message, artifacts: message.artifacts?.slice(0, 1) }}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    )
    expect(
      document.body.querySelector('.studio-artifact-pane-image img')?.getAttribute('src'),
    ).toContain('canvas')
    expect(document.body.textContent).not.toContain('正在载入产物')
    expect(
      (document.body.querySelector('.studio-artifact-pane-primary button') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    act(() =>
      (document.body.querySelector('.studio-artifact-pane-image') as HTMLButtonElement).click(),
    )
    expect(
      document.body.querySelector('[data-testid=zoomed]')?.getAttribute('data-original-pending'),
    ).toBe('true')
    await act(async () => resolveOriginal('data:image/png;base64,original'))
    expect(
      document.body.querySelector('[data-testid=zoomed]')?.getAttribute('data-original-pending'),
    ).toBe('false')
    expect(
      document.body.querySelector('.studio-artifact-pane-image img')?.getAttribute('src'),
    ).toContain('original')
    expect(
      (document.body.querySelector('.studio-artifact-pane-primary button') as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  } finally {
    act(() => root.unmount())
  }
})

it('ignores a late original after switching to another result', async () => {
  canvas.has.mockReturnValue(true)
  let resolveFirst!: (value: string | null) => void
  previewArtifactBitmap.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve
      }),
  )
  const root = createRoot(document.createElement('div'))
  const single = { ...message, artifacts: message.artifacts?.slice(0, 1) }
  try {
    await act(async () =>
      root.render(<AgentArtifactPane message={single} onSelect={vi.fn()} onClose={vi.fn()} />),
    )
    await act(async () =>
      root.render(
        <AgentArtifactPane
          message={message}
          selectedId="second"
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    )
    await act(async () => resolveFirst('data:image/png;base64,late-first'))
    expect(
      document.body.querySelector('.studio-artifact-pane-image img')?.getAttribute('src'),
    ).toContain('second')
  } finally {
    act(() => root.unmount())
  }
})

it('keeps a fetched preview visible and retries the original after a failure', async () => {
  let failOriginal = true
  resolveMediaSource.mockImplementation(async (_source, variant) => {
    if (variant === 'original' && failOriginal) {
      failOriginal = false
      throw new Error('network interrupted')
    }
    return variant === 'preview'
      ? 'data:image/png;base64,preview'
      : 'data:image/png;base64,original'
  })
  const root = createRoot(document.createElement('div'))
  const fetched = {
    ...message,
    artifacts: [],
    fetchedImages: [
      {
        imageId: '11000000-0000-4000-8000-000000000002',
        sourceUrl: 'https://example.test/image',
        mime: 'image/png',
        width: 1024,
        height: 1024,
      },
    ],
  }
  try {
    await act(async () =>
      root.render(<AgentArtifactPane message={fetched} onSelect={vi.fn()} onClose={vi.fn()} />),
    )
    expect(
      document.body.querySelector('.studio-artifact-pane-image img')?.getAttribute('src'),
    ).toContain('preview')
    const retry = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (one) => one.textContent === '重试载入',
    )!
    expect(retry).toBeDefined()
    await act(async () => retry.click())
    expect(
      document.body.querySelector('.studio-artifact-pane-image img')?.getAttribute('src'),
    ).toContain('original')
  } finally {
    act(() => root.unmount())
  }
})
