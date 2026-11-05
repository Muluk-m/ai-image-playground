// @vitest-environment jsdom
import type { AuthUserView } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../../auth/AuthContext'
import type * as LoginPromptModule from '../../../auth/loginPrompt'
import CliConnectPage from '../../../features/cli/CliConnectPage'
import {
  CLI_RELEASE_REF,
  CLI_VERSION,
  CONNECT_AGENTS,
  INSTALL_COMMAND,
  manualCommands,
  SESSION_PATH,
  skillInstallCommand,
} from '../../../features/cli/connectAgents'
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
  it('默认展示 WorkBuddy，插件顺序是 WorkBuddy、豆包、Claude Code、Codex、其他', async () => {
    await render()
    const labels = Array.from(
      host.querySelector('[aria-label="选择插件"]')?.querySelectorAll('button') ?? [],
      (button) => button.textContent,
    )
    expect(labels).toEqual(['WorkBuddy', '豆包', 'Claude Code', 'Codex', '其他'])
    expect(
      Array.from(host.querySelectorAll('[aria-label="选择插件"] img'), (img) =>
        img.getAttribute('src'),
      ),
    ).toEqual([
      '/connect-agents/workbuddy.svg',
      '/connect-agents/doubao.svg',
      '/connect-agents/claude-code.svg',
      '/connect-agents/codex.svg',
    ])
    expect(CONNECT_AGENTS).toEqual(['workbuddy', 'doubao', 'claude-code', 'codex', 'other'])
    expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe('WorkBuddy')
    expect(promptText()).toContain('WorkBuddy')
    expect(promptText()).toContain(INSTALL_COMMAND.unix)
    expect(promptText()).toContain('不要执行 `muvloom skill install`')
    expect(promptText()).not.toContain('--host workbuddy')
  })

  it('提示词随插件变化：只有 Claude Code 和 Codex 带 skill install，豆包不带', async () => {
    await render()
    await click('豆包')
    expect(promptText()).toContain('豆包')
    expect(promptText()).toContain('不要执行 `muvloom skill install`')
    expect(promptText()).not.toContain('--host doubao')
    expect(promptText()).toContain('muvloom auth login --no-wait')

    await click('Claude Code')
    expect(promptText()).toContain('muvloom skill install --host claude-code')

    await click('Codex')
    expect(promptText()).toContain('muvloom skill install --host codex')
    expect(promptText()).not.toContain('--host claude-code')

    await click('其他')
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
    await click('Claude Code')
    await click('我自己来')
    const shown = Array.from(host.querySelectorAll('pre > div'), (line) => line.textContent)
    expect(shown).toEqual([
      INSTALL_COMMAND.unix,
      SESSION_PATH.unix,
      'muvloom skill install --host claude-code',
      'muvloom auth login',
    ])
    await click('复制命令')
    expect(copyText).toHaveBeenCalledExactlyOnceWith(shown.join('\n'))
  })

  it('安装脚本固定在不可变提交并锁定 CLI 版本', () => {
    for (const command of Object.values(INSTALL_COMMAND)) {
      expect(command).toContain(`/${CLI_RELEASE_REF}/cli-go/install/`)
      expect(command).toContain(CLI_VERSION)
      expect(command).not.toContain('/main/')
      expect(command).not.toContain('cli-v')
    }
  })

  it('安装之后先补本次会话的 PATH，再调用 muvloom（首次安装时安装目录不在 PATH 里）', async () => {
    await render()
    for (const platform of ['unix', 'windows'] as const) {
      const lines = manualCommands('claude-code', platform)
      expect(lines.indexOf(SESSION_PATH[platform])).toBe(
        lines.indexOf(INSTALL_COMMAND[platform]) + 1,
      )
      expect(lines.findIndex((line) => line.startsWith('muvloom '))).toBeGreaterThan(
        lines.indexOf(SESSION_PATH[platform]),
      )
    }
    expect(promptText()).toContain(SESSION_PATH.unix)
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
    expect(host.textContent).toContain('暂无已连接的插件')
  })

  it('WorkBuddy 和豆包的手动命令只有安装、补 PATH 和登录', () => {
    for (const agent of ['workbuddy', 'doubao'] as const) {
      expect(skillInstallCommand(agent)).toBeNull()
      for (const platform of ['unix', 'windows'] as const) {
        expect(manualCommands(agent, platform)).toEqual([
          INSTALL_COMMAND[platform],
          SESSION_PATH[platform],
          'muvloom auth login',
        ])
      }
    }
    expect(skillInstallCommand('claude-code')).toBe('muvloom skill install --host claude-code')
    expect(skillInstallCommand('codex')).toBe('muvloom skill install --host codex')
  })
})
