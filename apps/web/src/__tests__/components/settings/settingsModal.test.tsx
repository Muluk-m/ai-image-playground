// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const byok = vi.hoisted(() => ({ enabled: true }))

vi.mock('../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/clientCapabilities')>()),
  isByokGenerationEnabled: () => byok.enabled,
}))

const dataActions = vi.hoisted(() => ({
  exportData: vi.fn(),
  clearData: vi.fn(),
  importData: vi.fn(),
}))

vi.mock('../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../store')>()),
  exportData: dataActions.exportData,
  clearData: dataActions.clearData,
  importData: dataActions.importData,
}))

import { AuthContextProvider } from '../../../auth/AuthContext'
import SettingsModal from '../../../components/SettingsModal'
import {
  clientProfileToApiProfile,
  DEFAULT_SETTINGS,
  getActiveApiProfile,
} from '../../../lib/apiProfiles'
import { useStore } from '../../../store'
import { stubPointerApis } from '../../helpers/radix'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function render(user: { id: string; username: string } | null = null): void {
  act(() => {
    root.render(
      <AuthContextProvider value={{ enabled: true, user, login: () => {}, logout: async () => {} }}>
        <SettingsModal />
      </AuthContextProvider>,
    )
  })
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error('missing element')
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function navButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('nav button')).find(
    (button) => button.textContent?.trim() === label,
  )
}

function switchByLabel(label: string): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(
    `[role="switch"][aria-label="${label}"]`,
  )
  if (!control) throw new Error(`missing switch ${label}`)
  return control
}

function section(title: string): HTMLElement {
  const found = Array.from(document.querySelectorAll('section')).find((one) =>
    one.querySelector('h4')?.textContent?.includes(title),
  )
  if (!found) throw new Error(`missing section ${title}`)
  return found
}

/** 三张卡的勾选框标签一模一样，只能按所属的那一段找。 */
function cardCheckbox(sectionTitle: string, label: string): HTMLElement {
  const card = section(sectionTitle)
  const controlId = Array.from(card.querySelectorAll('label'))
    .find((one) => one.textContent?.trim() === label)
    ?.getAttribute('for')
  const box = controlId ? document.getElementById(controlId) : null
  if (!box) throw new Error(`missing checkbox ${label}`)
  return box
}

function cardButton(sectionTitle: string, label: string): HTMLButtonElement {
  const button = Array.from(section(sectionTitle).querySelectorAll('button')).find(
    (one) => one.textContent?.trim() === label,
  )
  if (!button) throw new Error(`missing button ${label}`)
  return button
}

beforeEach(() => {
  stubPointerApis()
  byok.enabled = true
  dataActions.exportData.mockClear()
  dataActions.clearData.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useStore.setState({ settings: { ...DEFAULT_SETTINGS }, showSettings: true, confirmDialog: null })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useStore.setState({ settings: { ...DEFAULT_SETTINGS }, showSettings: false, confirmDialog: null })
})

describe('通用页', () => {
  it('每个开关各写各的那一项设置', () => {
    render()

    click(switchByLabel('提交任务后清空输入框'))
    expect(useStore.getState().settings.clearInputAfterSubmit).toBe(
      !DEFAULT_SETTINGS.clearInputAfterSubmit,
    )

    click(switchByLabel('重启后恢复上次的输入'))
    expect(useStore.getState().settings.persistInputOnRestart).toBe(
      !DEFAULT_SETTINGS.persistInputOnRestart,
    )

    click(switchByLabel('成功任务仍然展示重试按钮'))
    const settings = useStore.getState().settings
    expect(settings.alwaysShowRetryButton).toBe(!DEFAULT_SETTINGS.alwaysShowRetryButton)
    // 三行互不串台：前两项停在各自翻过的那一面。
    expect(settings.clearInputAfterSubmit).toBe(!DEFAULT_SETTINGS.clearInputAfterSubmit)
    expect(settings.persistInputOnRestart).toBe(!DEFAULT_SETTINGS.persistInputOnRestart)
  })

  it('显示设置就是头像菜单里那两个下拉', () => {
    render()

    expect(document.querySelector('[data-display-setting="locale"]')?.textContent).toContain('中文')
    expect(document.querySelector('[data-display-setting="theme"]')?.textContent).toContain(
      '跟随系统',
    )
  })
})

describe('没有 BYOK 的部署', () => {
  it('API 页连内容都不渲染，不只是藏起入口', () => {
    render()
    click(navButton('API'))
    expect(document.body.textContent).toContain('当前配置')

    byok.enabled = false
    render()

    expect(navButton('API')).toBeUndefined()
    expect(document.body.textContent).not.toContain('当前配置')
  })
})

describe('API 页', () => {
  it('关弹窗时把还没失焦的输入落盘', () => {
    render()
    click(navButton('API'))

    const field = Array.from(document.querySelectorAll('label')).find((one) =>
      one.textContent?.includes('配置名称'),
    )
    const input = field?.querySelector('input')
    if (!input) throw new Error('missing profile name input')
    // 受控 input 要走原生 setter，React 才认这次变化。
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(input, '我的配置')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // 背景点击与 ESC 都不会让输入框失焦，草稿只能靠关弹窗这一下落盘。
    click(document.querySelector('[aria-label="关闭"]'))

    expect(useStore.getState().showSettings).toBe(false)
    const active = getActiveApiProfile(useStore.getState().settings)
    expect(clientProfileToApiProfile(active).name).toBe('我的配置')
  })
})

describe('数据页', () => {
  it('勾选框决定导出与清除的范围', () => {
    render()
    click(navButton('数据'))

    click(cardCheckbox('导出数据', '包含任务和图片'))
    click(cardButton('导出数据', '导出所选数据'))
    expect(dataActions.exportData).toHaveBeenCalledWith({ exportConfig: true, exportTasks: false })

    click(cardCheckbox('清除数据', '包含配置'))
    click(cardButton('清除数据', '清空所选数据'))
    expect(dataActions.clearData).not.toHaveBeenCalled()

    act(() => useStore.getState().confirmDialog?.action())
    expect(dataActions.clearData).toHaveBeenCalledWith({ clearConfig: false, clearTasks: true })
  })

  it('登录后才有账号那一段', () => {
    render()
    click(navButton('数据'))
    expect(document.body.textContent).not.toContain('退出登录')

    render({ id: 'u1', username: '小马' })
    expect(document.body.textContent).toContain('小马')
    expect(document.body.textContent).toContain('退出登录')
  })
})
