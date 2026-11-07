// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserView } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../../auth/AuthContext'
import type * as LoginPromptModule from '../../../auth/loginPrompt'
import CliConnectionsDialog from '../../../features/cli/CliConnectionsDialog'
import CliConnectPage from '../../../features/cli/CliConnectPage'
import {
  AGENT_SETUP_PATH,
  CLI_RELEASE_REF,
  CLI_VERSION,
  CONNECT_AGENTS,
  INSTALL_COMMAND,
  manualCommands,
  SESSION_PATH,
  skillInstallCommand,
  WORKBUDDY_SETUP_PATH,
  WORKBUDDY_SKILL_PATH,
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
    expect(labels).toEqual(['WorkBuddy', '豆包工作', 'Claude Code', 'Codex', '其他'])
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
    expect(promptText()).toContain(new URL(WORKBUDDY_SETUP_PATH, window.location.origin).href)
    expect(promptText()).not.toContain('curl')
    expect(host.querySelector('[aria-label="选择系统"]')).toBeNull()
  })

  it('WorkBuddy 对话安装使用专用指南，技能下载只出现在手动方式', async () => {
    await render()
    expect(host.querySelector(`a[href="${WORKBUDDY_SKILL_PATH}"]`)).toBeNull()
    expect(promptText()).toContain(new URL(WORKBUDDY_SETUP_PATH, window.location.origin).href)
    await click('我自己来')
    expect(host.querySelector(`a[href="${WORKBUDDY_SKILL_PATH}"][download]`)).not.toBeNull()
    await click('让 Agent 安装')
    expect(host.querySelector(`a[href="${WORKBUDDY_SKILL_PATH}"]`)).toBeNull()
    await click('Codex')
    expect(host.querySelector(`a[href="${WORKBUDDY_SKILL_PATH}"]`)).toBeNull()
    expect(promptText()).toContain(new URL(AGENT_SETUP_PATH, window.location.origin).href)
  })

  it('各插件都只复制简短的接入请求和指南地址，隐藏安装细节', async () => {
    await render()
    for (const label of ['WorkBuddy', '豆包工作', 'Claude Code', 'Codex', '其他']) {
      await click(label)
      expect(promptText()).toContain(label === '其他' ? '当前 Agent' : label)
      expect(promptText().split('\n')).toHaveLength(2)
      expect(promptText()).not.toMatch(/curl|PowerShell|PATH|muvloom auth|--host/)
    }
  })

  it('复制的就是屏幕上这段简短提示词', async () => {
    await render()
    await click('复制提示词')
    expect(copyText).toHaveBeenCalledExactlyOnceWith(promptText())
    expect(button('已复制')).toBeTruthy()
  })

  it('只有手动安装需要选择系统，Windows 命令可见并可复制', async () => {
    await render()
    await click('我自己来')
    await click('Windows')
    expect(host.querySelector('pre')?.textContent).toContain(INSTALL_COMMAND.windows)
    expect(host.querySelector('pre')?.textContent).not.toContain(INSTALL_COMMAND.unix)
    await click('复制命令')
    expect(copyText).toHaveBeenCalledExactlyOnceWith(
      manualCommands('workbuddy', 'windows').join('\n'),
    )
    await click('让 Agent 安装')
    expect(host.querySelector('[aria-label="选择系统"]')).toBeNull()
    expect(promptText()).not.toContain('PowerShell')
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
  })

  it('Agent 指南保留经过校验的安装、PATH、宿主兼容与授权步骤', () => {
    const guide = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../public/cli/setup.md'),
      'utf8',
    )
    for (const platform of ['unix', 'windows'] as const) {
      expect(guide).toContain(INSTALL_COMMAND[platform])
      expect(guide).toContain(SESSION_PATH[platform])
    }
    for (const agent of ['claude-code', 'codex'] as const) {
      expect(guide).toContain(skillInstallCommand(agent))
    }
    expect(guide).toContain('muvloom auth login --no-wait')
    expect(guide).toContain('muvloom auth status')
    expect(guide).toContain('service_mismatch')
    // An older CLI already on the machine must be upgraded, not reused.
    expect(guide.replace(/\s+/g, ' ')).toContain(`lower than ${CLI_VERSION}`)
    expect(guide).toContain('--switch-service')
    expect(guide).toContain('muvloom capabilities')
    expect(guide).toContain('https://test-api.muvloom.online')
    expect(guide).not.toMatch(/--host (workbuddy|doubao)/)
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

  it('旧的连接弹层不再打开，直接进入 /connect', async () => {
    window.history.replaceState(null, '', '/image')
    const onClose = vi.fn()
    await act(async () => {
      root.render(<CliConnectionsDialog onClose={onClose} />)
    })
    expect(onClose).toHaveBeenCalledOnce()
    expect(window.location.pathname).toBe('/connect')
    expect(host.textContent).not.toContain('CLI 连接')
  })
})
