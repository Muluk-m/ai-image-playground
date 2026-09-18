// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlaceholderOverlay from '../../../../features/canvas/components/PlaceholderOverlay'
import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { projectScene } from '../../../../features/canvas/lib/projectMedia'
import { AUTH_SESSION_EXPIRED_EVENT } from '../../../../lib/authClient'
import { notifyPrivateSubmissionError } from '../../../../lib/privateOverlay'

const agent = vi.hoisted(() => ({ send: vi.fn(), conversationId: 'conv-1' as string | null }))
const send = agent.send

vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: Object.assign((select: (state: typeof agent) => unknown) => select(agent), {
    getState: () => agent,
  }),
}))

// 收费形态、开了积分与登录：去充值 / 去登录都有真实入口。
vi.mock('../../../../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/privateOverlay')>()),
  notifyPrivateSubmissionError: vi.fn(),
  PrivateWebOverlayPresent: true,
}))
vi.mock('../../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled: () => true,
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let editor: CanvasEditor
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  host = document.createElement('div')
  root = createRoot(host)
  send.mockClear()
  agent.conversationId = 'conv-1'
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

async function failedPlaceholder(
  message: string,
  code?: 'invalid_params' | 'upstream_error' | 'result_unknown',
) {
  const sink = createAgentCanvasSink(editor)
  const ids = await sink.reserve({
    count: 1,
    messageId: 'tool-1',
    conversationId: 'conv-1',
    title: '一只橘猫',
  })
  sink.markFailed(ids, message, code)
  act(() => root.render(<PlaceholderOverlay editor={editor} />))
}

it('失败占位按错误码显示原因与出路，不显示服务端的文字', async () => {
  await failedPlaceholder('服务端写的那句话', 'invalid_params')

  expect(host.textContent).toContain('这次的参数不成立，没有提交')
  expect(host.textContent).not.toContain('服务端写的那句话')
  const button = host.querySelector('button')!
  expect(button.textContent).toBe('让助手重新处理')

  act(() => button.click())
  expect(send).toHaveBeenCalledWith(
    '「一只橘猫」没有完成：这次的参数不成立，没有提交。请换个做法重新处理。',
  )
})

it('要重试才解决得了的失败，这里只说原因', async () => {
  await failedPlaceholder('服务端写的那句话', 'upstream_error')

  expect(host.textContent).toContain('生成服务出错了，这次没有出来')
  expect(host.querySelector('button')).toBeNull()
})

it('旧占位框没有错误码：照旧显示存下的那句话，没有按钮', async () => {
  await failedPlaceholder('上游拒绝了这张图')

  expect(host.textContent).toContain('上游拒绝了这张图')
  expect(host.querySelector('button')).toBeNull()
})

it('占位所属的会话没打开时，不给「让助手重新处理」，免得这句话落进别的会话', async () => {
  agent.conversationId = 'conv-2'
  await failedPlaceholder('服务端写的那句话', 'invalid_params')

  expect(host.textContent).toContain('这次的参数不成立，没有提交')
  expect(host.querySelector('button')).toBeNull()

  // 切回占位所属的会话，出路就回来了。
  agent.conversationId = 'conv-1'
  act(() => root.render(<PlaceholderOverlay editor={editor} key="again" />))
  expect(host.querySelector('button')?.textContent).toBe('让助手重新处理')
})

it('结果未知的失败只说原因，不给出路', async () => {
  await failedPlaceholder('服务端写的那句话', 'result_unknown')

  expect(host.textContent).toContain('这次的结果没能确认')
  expect(host.querySelector('button')).toBeNull()
})

function cloudFailedPlaceholder(code: 'timeout') {
  const generationId = '70cf33ea-d548-4a2b-ab0b-4a10e2e444fb'
  const scene = projectScene(
    {
      version: 1,
      elements: [
        {
          id: `agent_${generationId}_0`,
          type: 'generation',
          generationId,
          position: 0,
          x: 0,
          y: 0,
          width: 360,
          height: 360,
          errorCode: code,
        },
      ],
    },
    new Map(),
    'conv-1',
  )
  editor.doc.restore(scene.elements, scene.files)
  act(() => root.render(<PlaceholderOverlay editor={editor} />))
}

/** 云端项目上提交就被拒：服务端没留位置，失败占位由本机补上。 */
async function cloudRefusedPlaceholder(
  code: 'insufficient_credits' | 'authentication_required' | 'model_unavailable',
) {
  const sink = createAgentCanvasSink(editor, undefined, {
    enabled: () => true,
    refresh: () => Promise.resolve(),
  })
  const ids = await sink.reserve({
    count: 1,
    messageId: 'tool-cloud',
    conversationId: 'conv-1',
    title: '一只橘猫',
  })
  sink.markFailed(ids, '服务端写的那句话', code)
  act(() => root.render(<PlaceholderOverlay editor={editor} />))
}

it('云端项目积分不够被拒：失败占位给去充值', async () => {
  await cloudRefusedPlaceholder('insufficient_credits')

  const button = host.querySelector('button')!
  expect(button.textContent).toBe('去充值')
  act(() => button.click())
  expect(notifyPrivateSubmissionError).toHaveBeenCalledWith({ insufficientCredits: true })
})

it('云端项目没登录被拒：失败占位给去登录', async () => {
  await cloudRefusedPlaceholder('authentication_required')

  const button = host.querySelector('button')!
  expect(button.textContent).toBe('去登录')
  const expired = vi.fn()
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
  act(() => button.click())
  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
  expect(expired).toHaveBeenCalledTimes(1)
})

it('云端项目模型不可用被拒：失败占位给让助手重新处理，发回项目的会话', async () => {
  await cloudRefusedPlaceholder('model_unavailable')

  const button = host.querySelector('button')!
  expect(button.textContent).toBe('让助手重新处理')
  act(() => button.click())
  expect(send).toHaveBeenCalledWith(expect.stringMatching(/^「一只橘猫」没有完成：/))
})

it('云端项目超时的失败占位只说原因', () => {
  cloudFailedPlaceholder('timeout')

  expect(host.querySelector('button')).toBeNull()
  expect(host.textContent).toContain('生成超时，这次没有出来')
})
