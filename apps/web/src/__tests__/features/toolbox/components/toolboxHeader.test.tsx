// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ToolboxHeader from '../../../../features/toolbox/components/ToolboxHeader'
import { useToolboxStore } from '../../../../features/toolbox/store'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('URL', { revokeObjectURL: vi.fn() })
  useToolboxStore.setState({
    activeTool: 'export',
    items: Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      name: `${index}.png`,
      url: `blob:${index}`,
      type: 'image/png',
      size: 10,
      width: 10,
      height: 10,
      decodable: true,
    })),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useToolboxStore.getState().clear()
  vi.unstubAllGlobals()
})
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent === label,
  )
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
it('keeps import available with existing images, returns without losing them, and clears a batch in one action', async () => {
  const openFiles = vi.fn()
  const openFolder = vi.fn()
  await act(async () =>
    root.render(
      <ToolboxHeader title="图片尺寸调整" back onAddImages={openFiles} onAddFolder={openFolder} />,
    ),
  )
  expect(host.textContent).toContain('已导入 8 张')
  await act(async () => button('添加图片').click())
  expect(openFiles).toHaveBeenCalledOnce()
  await act(async () => button('返回工具箱').click())
  expect(useToolboxStore.getState().activeTool).toBeNull()
  expect(useToolboxStore.getState().items).toHaveLength(8)
  await act(async () => button('清空全部').click())
  expect(useToolboxStore.getState().items).toHaveLength(0)
  await act(async () => button('添加图片').click())
  expect(openFiles).toHaveBeenCalledTimes(2)
  await act(async () => button('文件夹').click())
  expect(openFolder).toHaveBeenCalledOnce()
})
it('keeps import controls visible but protects the current export from changes while busy', async () => {
  const openFiles = vi.fn()
  await act(async () =>
    root.render(
      <ToolboxHeader
        title="图片尺寸调整"
        back
        busy
        onAddImages={openFiles}
        onAddFolder={vi.fn()}
      />,
    ),
  )
  expect(button('添加图片').disabled).toBe(true)
  expect(button('文件夹').disabled).toBe(true)
  expect(button('清空全部').disabled).toBe(true)
  await act(async () => button('添加图片').click())
  expect(openFiles).not.toHaveBeenCalled()
  expect(useToolboxStore.getState().items).toHaveLength(8)
})
