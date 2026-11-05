// @vitest-environment jsdom
import type { AuthUserView } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../../auth/AuthContext'
import type * as LoginPromptModule from '../../../auth/loginPrompt'
import CliConnectPage from '../../../features/cli/CliConnectPage'
import { INSTALL_COMMAND } from '../../../features/cli/connectAgents'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const { promptLogin, copyText } = vi.hoisted(() => ({ promptLogin: vi.fn(), copyText: vi.fn() }))
vi.mock('../../../auth/loginPrompt', async (importOriginal) => ({
  ...(await importOriginal<typeof LoginPromptModule>()),
  promptLogin,
}))
vi.mock('../../../lib/clipboardText', () => ({ copyTextToClipboard: copyText }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const USER: AuthUserView = { id: 'user-1', username: 'creator' }
let host: HTMLDivElement
let root: Root

async function render(user: AuthUserView | null = USER) {
  await act(async () => {
    root.render(
      <AuthContextProvider value={{ enabled: true, user, login: () => {}, logout: async () => {} }}>
        <CliConnectPage />
      </AuthContextProvider>,
    )
  })
}

function button(label: string): HTMLButtonElement {
  const target = Array.from(host.querySelectorAll('button')).find(
    (item) => item.textContent === label,
  )
  if (!target) throw new Error(`Missing button: ${label}`)
  return target
}

async function click(label: string) {
  await act(async () => button(label).click())
}

const promptText = () => host.querySelector('[data-slot="connect-prompt"]')?.textContent ?? ''

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://api.example.com' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ connections: [] })),
  )
  window.history.replaceState(null, '', '/connect')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  promptLogin.mockClear()
  copyText.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('CliConnectPage', () => {
  it('提示词随 Agent 变化：有 Skill 的宿主带安装 Skill 一步，其他 Agent 没有', async () => {
    await render()
    expect(promptText()).toContain('muvloom skill install --host claude-code')

    await click('Codex')
    expect(promptText()).toContain('muvloom skill install --host codex')
    expect(promptText()).not.toContain('--host claude-code')

    await click('其他 Agent')
    expect(promptText()).not.toContain('muvloom skill install')
    expect(promptText()).toContain('muvloom auth login --no-wait')
  })

  it('切到 Windows 后提示词换成 PowerShell 安装命令，复制的就是屏幕上这段', async () => {
    await render()
    await click('Windows')
    expect(promptText()).toContain(INSTALL_COMMAND.windows)
    expect(promptText()).not.toContain(INSTALL_COMMAND.unix)

    await click('复制提示词')
    expect(copyText).toHaveBeenCalledExactlyOnceWith(promptText())
    expect(button('已复制')).toBeTruthy()
  })

  it('手动方式列出逐行命令，复制的是命令而不是提示词', async () => {
    await render()
    await click('我自己来')
    const shown = Array.from(host.querySelectorAll('pre > div'), (line) => line.textContent)
    expect(shown).toEqual([
      INSTALL_COMMAND.unix,
      'muvloom skill install --host claude-code',
      'muvloom auth login',
    ])
    await click('复制命令')
    expect(copyText).toHaveBeenCalledExactlyOnceWith(shown.join('\n'))
  })

  it('剪贴板被拒时提示复制失败，不假装成功', async () => {
    copyText.mockRejectedValueOnce(new Error('denied'))
    await render()
    await click('复制提示词')
    expect(button('复制失败')).toBeTruthy()
  })

  it('未登录不去读已连接设备，给出登录入口；登录后才请求', async () => {
    await render(null)
    expect(fetch).not.toHaveBeenCalled()
    await click('登录后继续')
    expect(promptLogin).toHaveBeenCalledWith('gated-action')

    await render(USER)
    expect(fetch).toHaveBeenCalled()
    expect(host.textContent).toContain('暂无已连接的 CLI')
  })
})
