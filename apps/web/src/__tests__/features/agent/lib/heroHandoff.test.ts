// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startCanvasFromComposer } from '../../../../features/agent/lib/heroHandoff'
import { currentProjectDraft } from '../../../../features/agent/lib/projectLifecycle'
import { useAgentStore } from '../../../../features/agent/store'
import { currentCanvasWorkspace } from '../../../../features/canvas/lib/activeProject'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'
import { useStore } from '../../../../store'
import { openCanvas } from '../../../helpers/activeProject'

let turnResponse: () => Response
const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/capabilities')) return Response.json({ 'agent:chat': true })
  if (url.includes('/submissions/')) return Response.json({ receipt: null })
  if (url.endsWith('/conversations') && init?.method === 'POST')
    return Response.json({
      conversation: { id: crypto.randomUUID(), title: '', createdAt: 1, updatedAt: 1 },
    })
  if (url.includes('/turns')) return turnResponse()
  if (url.endsWith('/conversations')) return Response.json({ conversations: [] })
  return Response.json({ messages: [], turns: [], activeTurn: null })
})

beforeEach(async () => {
  history.replaceState(null, '', '/')
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useCanvasProjectStore.setState({ projects: [], activeId: null, loaded: false, error: null })
  await openCanvas()
  useAgentStore.setState({
    loaded: true,
    conversationId: null,
    messages: [],
    turns: {},
    turn: 'idle',
    stopping: false,
    activeTurn: null,
    error: null,
    historyFailed: false,
    historyLoading: false,
  })
})

afterEach(async () => {
  await currentCanvasWorkspace().flush()
  await bootstrapClientCapabilities(false, '')
  vi.unstubAllGlobals()
  fetchMock.mockClear()
  setClientStorageScope(null)
})

it('首屏发出去被服务端拒收（图太大）：错误卡说原因，这句话留在新项目的输入框里', async () => {
  turnResponse = () =>
    Response.json(
      {
        error: 'invalid_request',
        message: '/references/0/dataUrl: Expected string length less or equal to 4000000',
      },
      { status: 400 },
    )
  await startCanvasFromComposer({ prompt: '把沙发换成深绿色丝绒', references: [] }, 'chat')
  const state = useAgentStore.getState()
  expect(state.error).toContain('图片太大')
  expect(state.messages.filter((one) => one.kind === 'text')).toEqual([])
  const draft = currentProjectDraft(state.conversationId)
  await draft.ready
  await vi.waitFor(() => expect(draft.getSnapshot().draft.prompt).toBe('把沙发换成深绿色丝绒'))
})

it('首屏发出去被收下：新项目输入框不留这句话，首屏输入框清空', async () => {
  turnResponse = () =>
    new Response(
      [
        encodeAgentFrame(1, { type: 'turnStart', turnId: 'turn-1', userMessageId: 'user-1' }),
        encodeAgentFrame(2, {
          type: 'turnEnd',
          turnId: 'turn-1',
          durationMs: 5,
          stopReason: 'completed',
          usage: null,
        }),
      ].join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  useStore.getState().setPrompt('换个背景')
  await startCanvasFromComposer(undefined, 'chat')
  const draft = currentProjectDraft(useAgentStore.getState().conversationId)
  await draft.ready
  expect(draft.getSnapshot().draft.prompt).toBe('')
  expect(useStore.getState().prompt).toBe('')
})
