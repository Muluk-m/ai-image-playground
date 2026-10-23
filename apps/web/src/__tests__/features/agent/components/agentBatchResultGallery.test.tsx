// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentBatchPage, AgentToolArtifact } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AgentBatchResultGallery from '../../../../features/agent/components/AgentBatchResultGallery'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { panelMessage } from '../../../../features/agent/lib/panelMessages'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

const displayReads = vi.hoisted(() => [] as string[])

vi.mock('../../../../features/agent/lib/artifactSource', async (original) => ({
  ...(await original<typeof import('../../../../features/agent/lib/artifactSource')>()),
  displayArtifactBitmap: async (artifact: AgentToolArtifact) => {
    displayReads.push(artifact.artifactId)
    return `data:image/png;base64,display-${artifact.taskId}`
  },
  previewArtifactBitmap: async (artifact: AgentToolArtifact) =>
    `data:image/png;base64,original-${artifact.taskId}`,
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const estimate = {
  status: 'available' as const,
  estimatedCredits: 14,
  estimatedChargeCredits: 14,
  snapshots: [],
}

function finishedPage(): AgentBatchPage {
  return {
    batch: {
      id: crypto.randomUUID(),
      conversationId: 'conversation-sink',
      originTurnId: 'turn-sink',
      projectId: null,
      experience: 'chat',
      targetSnapshot: { projectId: null, projectRevision: null },
      version: 1,
      digest: 'b'.repeat(64),
      title: '台盆场景图',
      rule: '每个角度一张酒店卫浴场景图',
      itemCount: 3,
      status: 'closed',
      executionEnabled: true,
      submittedCount: 3,
      actualCredits: 42,
      createdAt: 1,
      estimate: {
        analysis: { ...estimate, estimatedCredits: 0, estimatedChargeCredits: 0 },
        generation: estimate,
      },
    },
    items: [0, 1, 2].map((ordinal) => ({
      key: `angle-${ordinal}`,
      ordinal,
      kind: 'generation' as const,
      inputs: [
        {
          imageId: `image-${ordinal}`,
          mediaId: `fixture-media-${ordinal}`,
          name: `角度${ordinal + 1}.jpg`,
        },
      ],
      prompt: `角度${ordinal + 1}放进酒店卫浴`,
      params: { provider: 'openai-compat', model: 'image-model', size: '1024x1024' },
      dependencies: [],
      progress: ordinal === 2 ? ('failed' as const) : ('completed' as const),
      execution:
        ordinal === 2
          ? {
              taskId: 'task-failed',
              status: 'failed' as const,
              attempt: 1,
              actualCredits: 0,
              errorCode: 'upstream_error',
            }
          : {
              taskId: `task-${ordinal}`,
              status: 'completed' as const,
              attempt: 1,
              actualCredits: 14,
              artifacts: [
                {
                  artifactId: `artifact-${ordinal}`,
                  media: 'image' as const,
                  taskId: `task-${ordinal}`,
                  outputIndex: 0,
                  mime: 'image/png',
                },
              ],
            },
    })),
    nextCursor: null,
  }
}

afterEach(() => {
  displayReads.length = 0
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it('shows finished batch outputs as images in the chat without expanding any item', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const page = finishedPage()
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (!url.includes(`/api/agent/batches/${page.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    return Response.json(page)
  })
  const message = panelMessage('message-sink', 'turn-sink', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'call-sink',
      title: '台盆场景图',
      status: 'succeeded',
      batchId: page.batch.id,
    },
  ])
  if (message.kind !== 'tool') throw new Error('expected tool card')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentToolCard message={message} />))
    await vi.waitFor(() =>
      expect(
        [...host.querySelectorAll<HTMLImageElement>('img')].filter((img) =>
          img.src.includes('display-task-'),
        ),
      ).toHaveLength(2),
    )
    const results = [...host.querySelectorAll<HTMLImageElement>('img')].filter((img) =>
      img.src.includes('display-task-'),
    )
    // Every output sits outside the collapsed per-item rows: nothing has to be opened to see it.
    for (const img of results) expect(img.closest('details:not([open])')).toBeNull()
    expect(results.map((img) => img.src)).toEqual([
      'data:image/png;base64,display-task-0',
      'data:image/png;base64,display-task-1',
    ])
    expect(host.querySelector('details[open]')).toBeNull()

    await act(async () => results[1]!.closest('button')!.click())
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLImageElement>(
          'img[src="data:image/png;base64,original-task-1"]',
        ),
      ).not.toBeNull(),
    )
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

it('does not fetch shown thumbnails again when a poll brings the same outputs as new objects', async () => {
  const artifacts = (): AgentToolArtifact[] =>
    [0, 1].map((index) => ({
      artifactId: `poll-artifact-${index}`,
      media: 'image',
      taskId: `poll-task-${index}`,
      outputIndex: 0,
      mime: 'image/png',
    }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentBatchResultGallery artifacts={artifacts()} />))
    await vi.waitFor(() => expect(host.querySelectorAll('img')).toHaveLength(2))
    for (let poll = 0; poll < 3; poll++)
      await act(async () => root.render(<AgentBatchResultGallery artifacts={artifacts()} />))
    expect(host.querySelectorAll('img')).toHaveLength(2)
    expect(displayReads.sort()).toEqual(['poll-artifact-0', 'poll-artifact-1'])
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
