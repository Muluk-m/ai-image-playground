// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlaceholderOverlay from '../../../../features/canvas/components/PlaceholderOverlay'
import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { projectScene } from '../../../../features/canvas/lib/projectMedia'

const agent = vi.hoisted(() => ({ send: vi.fn(), conversationId: 'conv-1' as string | null }))
const send = agent.send

vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: Object.assign((select: (state: typeof agent) => unknown) => select(agent), {
    getState: () => agent,
  }),
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

function cloudFailedPlaceholder(code: 'model_unavailable' | 'timeout') {
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

it('云端项目的失败占位同样按错误码出原因与出路', () => {
  cloudFailedPlaceholder('model_unavailable')

  expect(host.textContent).toContain('生成失败')
  const button = host.querySelector('button')!
  expect(button.textContent).toBe('让助手重新处理')
  act(() => button.click())
  expect(send).toHaveBeenCalledWith(expect.stringMatching(/^「生成任务」没有完成：/))
})

it('云端项目超时的失败占位只说原因', () => {
  cloudFailedPlaceholder('timeout')

  expect(host.querySelector('button')).toBeNull()
  expect(host.textContent).toContain('生成超时，这次没有出来')
})
