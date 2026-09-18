// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlaceholderOverlay from '../../../../features/canvas/components/PlaceholderOverlay'
import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

const send = vi.hoisted(() => vi.fn())

vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: { getState: () => ({ send }) },
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
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

async function failedPlaceholder(message: string, code?: 'invalid_params' | 'upstream_error') {
  const sink = createAgentCanvasSink(editor)
  const ids = await sink.reserve({ count: 1, messageId: 'tool-1', title: '一只橘猫' })
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
