// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentBatchPage } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { panelMessage } from '../../../../features/agent/lib/panelMessages'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('shows whole-scope inspection findings without declaring an unresolved joint comparison complete', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const quote = {
    status: 'available' as const,
    estimatedCredits: 0,
    estimatedChargeCredits: 0,
    snapshots: [],
  }
  const page: AgentBatchPage = {
    batch: {
      id: crypto.randomUUID(),
      conversationId: 'original-chat',
      originTurnId: 'original-turn',
      projectId: 'original-project',
      experience: 'chat',
      targetSnapshot: { projectId: 'original-project', projectRevision: null },
      version: 1,
      digest: 'a'.repeat(64),
      title: '逐图检查并比较',
      rule: '检查两张商品图，再比较差异',
      itemCount: 3,
      status: 'paused',
      executionEnabled: true,
      submittedCount: 3,
      actualCredits: 2,
      estimate: { analysis: quote, generation: quote },
      createdAt: 1,
    },
    items: [
      {
        key: 'inspect-a',
        ordinal: 0,
        kind: 'analysis',
        prompt: '检查第一张',
        inputs: [{ imageId: 'a', mediaId: 'media-a', name: '商品甲' }],
        dependencies: [],
        params: {
          model: 'analysis-model',
          intent: 'inspection',
          estimatedInputTokens: 100,
          evidence: [],
        },
        progress: 'completed',
        execution: {
          taskId: 'task-a',
          status: 'completed',
          attempt: 1,
          actualCredits: 1,
          artifacts: [],
        },
      },
    ],
    nextCursor: 'page-two',
    analysisSummary: {
      complete: false,
      inspectionComplete: true,
      requiredImageIds: ['a', 'b'],
      successfulImageIds: ['a', 'b'],
      missingImageIds: [],
      unresolvedItemKeys: ['compare'],
      jointComparisons: [
        {
          itemKey: 'compare',
          taskId: 'task-compare',
          attempt: 1,
          status: 'reconciling',
          complete: false,
          requiredImageIds: ['a', 'b'],
        },
      ],
      findings: [
        {
          imageId: 'a',
          text: '商品甲表面平整',
          itemKey: 'inspect-a',
          taskId: 'task-a',
          attempt: 1,
          evidence: [],
        },
        {
          imageId: 'b',
          text: '另一页的商品有划痕',
          itemKey: 'inspect-b',
          taskId: 'task-b',
          attempt: 1,
          evidence: [],
        },
      ],
    },
  }
  const requests: { method: string; url: string }[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ method: init?.method ?? 'GET', url })
    if (!url.includes(`/api/agent/batches/${page.batch.id}`))
      throw new Error(`Unexpected URL: ${url}`)
    return Response.json(page)
  })
  const message = panelMessage('summary-message', 'original-turn', 'assistant', [
    {
      type: 'toolResult',
      toolName: 'planImageBatch',
      toolCallId: 'summary-call',
      title: page.batch.title,
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
    await vi.waitFor(() => expect(host.querySelector('details')).not.toBeNull())
    expect(host.textContent).toContain('图片覆盖 2 / 2')
    expect(host.textContent).toContain('逐图检查已完成')
    act(() => host.querySelector<HTMLElement>('section[aria-label="分析汇总"] summary')!.click())
    expect(host.querySelector('section[aria-label="分析汇总"] details')?.hasAttribute('open')).toBe(
      true,
    )
    expect(host.textContent).toContain('另一页的商品有划痕')
    expect(host.textContent).toContain('联合比较')
    expect(host.textContent).toContain('待核查')
    expect(host.textContent).not.toContain('分析已完成')
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
