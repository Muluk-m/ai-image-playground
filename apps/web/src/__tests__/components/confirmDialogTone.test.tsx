// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ConfirmDialog from '../../components/ConfirmDialog'
import { i18next, setLocale } from '../../i18n'
import { useStore } from '../../store'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

/** 确认按钮是唯一一个白字实心的，取消按钮是描边的。 */
function confirmButton(): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
  const found = buttons.find((button) => button.className.includes('text-white'))
  if (!found) throw new Error('missing confirm button')
  return found
}

async function open(dialog: NonNullable<ReturnType<typeof useStore.getState>['confirmDialog']>) {
  await act(async () => {
    useStore.getState().setConfirmDialog(dialog)
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<ConfirmDialog />))
})

afterEach(async () => {
  await act(async () => {
    useStore.getState().setConfirmDialog(null)
  })
  act(() => root.unmount())
  host.remove()
  await i18next.changeLanguage('zh-CN')
})

/**
 * 危险语气是靠标题里的动词猜出来的，这在中文里一直成立，翻成英文后就成了一条跨语言约定：
 * 英文标题必须用 Delete / Clear 这两个词，写成 Remove 红色会**静默**消失。
 * 这个文件把两种语言的行为都钉住，顺便钉住「显式 tone 说了算」这条。
 */
describe('确认框的危险语气', () => {
  it('中文标题含删除时给红色按钮与确认删除', async () => {
    await open({ title: '删除记录', message: '', action: () => {} })

    expect(confirmButton().className).toContain('bg-red-500')
    expect(confirmButton().textContent).toBe('确认删除')
  })

  it('英文标题含 Delete 时同样给红色，措辞跟着语言走', async () => {
    await act(async () => {
      await setLocale('en')
    })
    await open({ title: 'Delete record', message: '', action: () => {} })

    expect(confirmButton().className).toContain('bg-red-500')
    expect(confirmButton().textContent).toBe('Delete')
  })

  it('普通标题是蓝色的普通确认', async () => {
    await open({ title: '保存版本', message: '', action: () => {} })

    expect(confirmButton().className).toContain('bg-blue-500')
    expect(confirmButton().textContent).toBe('确认')
  })

  it('显式传 tone 时标题里没有动词也照样是危险语气', async () => {
    await open({ title: '这个标题不含任何动词', message: '', tone: 'danger', action: () => {} })

    expect(confirmButton().className).toContain('bg-red-500')
    expect(confirmButton().textContent).toBe('确认删除')
  })
})
