// @vitest-environment jsdom

import { createHash } from 'node:crypto'
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
  CLI_MIN_VERSION,
  CLI_VERSION,
  CONNECT_AGENTS,
  DOUBAO_SETUP_PATH,
  DOUBAO_SKILL_PATH,
  GENERIC_SKILL_PATH,
  INSTALL_PS1_SHA256,
  INSTALL_SH_SHA256,
  installScriptCommands,
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

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const cliDir = resolve(webRoot, 'public/cli')
const installDir = resolve(webRoot, '../../cli-go/install')

function guideRevision(): string {
  const text = ['setup.md', 'workbuddy.md', 'doubao.md']
    .map((name) => readFileSync(resolve(cliDir, name), 'utf8'))
    .join('\n')
  const installers = Buffer.concat(
    ['install.sh', 'install.ps1'].map((name) => readFileSync(resolve(installDir, name))),
  )
  return createHash('sha256').update(text).update(installers).digest('hex').slice(0, 10)
}

function setupGuide(): string {
  return readFileSync(resolve(cliDir, 'setup.md'), 'utf8')
}

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
  it('默认展示全宿主通用的一条消息，不包含 curl 或多宿主切换负担', async () => {
    await render()
    expect(CONNECT_AGENTS).toEqual(['workbuddy', 'doubao', 'claude-code', 'codex', 'other'])
    expect(promptText()).toContain(new URL(AGENT_SETUP_PATH, window.location.origin).href)
    expect(promptText()).not.toContain('curl')
    expect(promptText().split('\n')).toHaveLength(2)
    expect(host.querySelector('[aria-label="选择系统"]')).toBeNull()
    expect(host.querySelector(`a[href="${WORKBUDDY_SKILL_PATH}"]`)).toBeNull()
    expect(
      Array.from(host.querySelectorAll('img'), (img) => img.getAttribute('src')).filter((src) =>
        src?.startsWith('/connect-agents/'),
      ),
    ).toEqual([
      '/connect-agents/workbuddy.svg',
      '/connect-agents/doubao.svg',
      '/connect-agents/codex.svg',
      '/connect-agents/claude-code.svg',
    ])
  })

  it('手动安装折叠区提供各宿主命令与技能包下载', async () => {
    await render()
    expect(host.querySelector(`a[href="${WORKBUDDY_SKILL_PATH}"]`)).toBeNull()
    await click('手动安装或下载技能包')
    expect(host.querySelector(`a[href="${WORKBUDDY_SKILL_PATH}"][download]`)).not.toBeNull()
    await click('豆包工作')
    expect(host.querySelector(`a[href="${DOUBAO_SKILL_PATH}"][download]`)).not.toBeNull()
    expect(host.textContent).toContain('插件·技能·伙伴')
    await click('其他')
    expect(host.querySelector(`a[href="${GENERIC_SKILL_PATH}"][download]`)).not.toBeNull()
    await click('Codex')
    expect(host.querySelector(`a[href="${WORKBUDDY_SKILL_PATH}"]`)).toBeNull()
    expect(host.querySelector(`a[href="${DOUBAO_SKILL_PATH}"]`)).toBeNull()
  })

  // 抓取工具会缓存网页：换了指南内容而网址不变，用户拿到的还是旧的固定版本命令。
  it('提示词里的指南网址带着指南内容的哈希，内容一变网址就变', async () => {
    const rev = guideRevision()
    await render()
    expect(promptText()).toContain(
      `${new URL(AGENT_SETUP_PATH, window.location.origin).href}?v=${rev}`,
    )
  })

  it('指南都要求授权走系统默认浏览器，并覆盖无浏览器控制的宿主', () => {
    const setup = setupGuide()
    const workbuddy = readFileSync(resolve(cliDir, 'workbuddy.md'), 'utf8')
    const doubao = readFileSync(resolve(cliDir, 'doubao.md'), 'utf8')
    for (const [name, text] of [
      ['setup.md', setup],
      ['workbuddy.md', workbuddy],
      ['doubao.md', doubao],
    ] as const) {
      expect(text, name).not.toContain('muvloom auth login --timeout 60')
      expect(text, name).toContain('AUTH_PENDING')
      expect(text, name).not.toMatch(/必须使用 Chrome|请使用 Chrome|must use Chrome/)
    }
    expect(setup).toContain('system default browser')
    expect(setup).toContain('Never pick Chrome')
    expect(setup).toContain('never run `Start-Process`')
    expect(workbuddy).toContain('系统默认浏览器')
    expect(doubao).toContain('系统默认浏览器')
    expect(workbuddy).not.toContain('立即结束本回合')
    expect(setup).toContain('MUVLOOM_NO_BROWSER=1')
    expect(setup).toContain('verification_uri_complete')
    expect(setup.replace(/\s+/g, ' ').toLowerCase()).toContain('do not end your turn')
    expect(doubao).toContain('不要指定 Chrome')
    expect(doubao).toContain('操作电脑')
    expect(doubao).toContain('附属浏览器')
    expect(workbuddy).toContain('CLI 会尝试打开默认浏览器')
    expect(workbuddy).toContain('`muvloom --json auth login --timeout 15`')
    expect(workbuddy).toContain(
      '第一次返回 `AUTH_PENDING` 时，立即把同一次授权的 `verification_uri_complete`',
    )
  })

  // 机器已连着测试或企业服务时打开生产页面：不显式指定服务，CLI 会沿用已存连接，接入静默"成功"在错误环境上。
  it('指南对每个服务（含生产）都显式指定 API 地址，让 CLI 能发现与已存连接不一致', () => {
    const setup = setupGuide().replace(/\s+/g, ' ')
    expect(setup).not.toContain('use the default')
    expect(setup).not.toContain('clear any conflicting')
    expect(setup).toContain('including the production service')
    expect(setup).toContain('service_mismatch')
  })

  it('各份指南都要求抓取同目录的另一份时沿用同一个 v 参数', () => {
    for (const name of ['setup.md', 'workbuddy.md', 'doubao.md']) {
      expect(readFileSync(resolve(cliDir, name), 'utf8'), name).toContain('?v=')
    }
  })

  it('复制的就是屏幕上这段简短消息', async () => {
    await render()
    await click('复制消息')
    expect(copyText).toHaveBeenCalledExactlyOnceWith(promptText())
    expect(button('已复制')).toBeTruthy()
  })

  it('只有展开手动安装才选择系统，Windows 命令可见并可复制', async () => {
    await render()
    await click('手动安装或下载技能包')
    await click('Windows')
    const shown = host.querySelector('pre')?.textContent ?? ''
    expect(shown).toContain('Invoke-WebRequest')
    expect(shown).toContain(INSTALL_PS1_SHA256)
    expect(shown).toContain(`MUVLOOM_MIN_VERSION`)
    expect(shown).not.toContain('mktemp')
    await click('复制命令')
    expect(copyText).toHaveBeenCalledExactlyOnceWith(
      manualCommands('workbuddy', 'windows', window.location.origin).join('\n'),
    )
    await click('手动安装或下载技能包')
    expect(host.querySelector('[aria-label="选择系统"]')).toBeNull()
    expect(promptText()).not.toContain('PowerShell')
  })

  it('手动方式列出逐行命令，复制的是命令而不是提示词', async () => {
    await render()
    await click('手动安装或下载技能包')
    await click('Claude Code')
    const shown = Array.from(host.querySelectorAll('pre > div'), (line) => line.textContent)
    expect(shown).toEqual([
      ...installScriptCommands('unix', window.location.origin),
      SESSION_PATH.unix,
      'muvloom skill install --host claude-code',
      'muvloom auth login',
    ])
    await click('复制命令')
    expect(copyText).toHaveBeenCalledExactlyOnceWith(shown.join('\n'))
  })

  it('安装命令先校验脚本校验和，再用最低版本安装，不会钉死可降级的精确版本', () => {
    const origin = 'https://muvloom.online'
    const unix = installScriptCommands('unix', origin).join('\n')
    const windows = installScriptCommands('windows', origin).join('\n')
    expect(unix).toContain(INSTALL_SH_SHA256)
    expect(windows).toContain(INSTALL_PS1_SHA256)
    expect(unix).toContain(`MUVLOOM_MIN_VERSION=${CLI_MIN_VERSION}`)
    expect(windows).toContain(`MUVLOOM_MIN_VERSION = "${CLI_MIN_VERSION}"`)
    expect(unix).not.toContain('MUVLOOM_VERSION=')
    expect(unix).not.toMatch(/curl .*\| sh/)
    expect(windows).not.toMatch(/irm .*\| iex/)
    expect(windows).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File $script')
    expect(windows).toContain('$LASTEXITCODE')
    expect(windows).not.toContain('& $script')
    expect(unix).toContain('/cli/install.sh')
    expect(windows).toContain('/cli/install.ps1')
    expect(CLI_VERSION).toBe(CLI_MIN_VERSION)
  })

  it('安装之后先补本次会话的 PATH，再调用 muvloom（首次安装时安装目录不在 PATH 里）', async () => {
    await render()
    for (const platform of ['unix', 'windows'] as const) {
      const lines = manualCommands('claude-code', platform, window.location.origin)
      const pathIndex = lines.indexOf(SESSION_PATH[platform])
      expect(pathIndex).toBeGreaterThan(0)
      expect(lines[pathIndex - 1]).toContain('MUVLOOM_MIN_VERSION')
      expect(lines.findIndex((line) => line.startsWith('muvloom '))).toBeGreaterThan(pathIndex)
    }
  })

  it('Agent 指南保留经过校验的安装、PATH、宿主兼容与授权步骤', () => {
    const guide = setupGuide()
    expect(guide).toContain(INSTALL_SH_SHA256)
    expect(guide).toContain(INSTALL_PS1_SHA256)
    expect(guide).toContain(`MUVLOOM_MIN_VERSION=${CLI_MIN_VERSION}`)
    expect(guide).toContain(SESSION_PATH.unix)
    expect(guide).toContain(SESSION_PATH.windows)
    for (const agent of ['claude-code', 'codex'] as const) {
      expect(guide).toContain(skillInstallCommand(agent))
    }
    expect(guide).toContain('muvloom auth login --no-wait')
    expect(guide).toContain('muvloom auth status')
    expect(guide).toContain('service_mismatch')
    expect(guide.replace(/\s+/g, ' ')).toContain(`lower than ${CLI_MIN_VERSION}`)
    expect(guide).toContain('--switch-service')
    expect(guide).toContain('muvloom capabilities')
    expect(guide).toContain('images validate')
    expect(guide).toContain('https://test-api.muvloom.online')
    expect(guide).toContain('before the first `muvloom auth status`')
    expect(guide).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File $script')
    expect(guide).toContain('$LASTEXITCODE')
    expect(guide).not.toContain('& $script')
    expect(guide).not.toContain('only around the first `muvloom auth login`')
    expect(guide).toContain('system default browser')
    expect(guide).not.toMatch(/muvloom skill install --host (workbuddy|doubao)/)
    expect(guide.replace(/\s+/g, ' ')).toContain('do not write it into a profile')
    expect(guide).toContain('credential_store_issue')
    expect(guide).not.toContain('MUVLOOM_VERSION=0.2.4')
  })

  it('WorkBuddy 和豆包的手动命令只有安装、补 PATH 和登录，没有虚构的 --host', () => {
    const origin = 'https://muvloom.online'
    for (const agent of ['workbuddy', 'doubao'] as const) {
      expect(skillInstallCommand(agent)).toBeNull()
      for (const platform of ['unix', 'windows'] as const) {
        expect(manualCommands(agent, platform, origin)).toEqual([
          ...installScriptCommands(platform, origin),
          SESSION_PATH[platform],
          'muvloom auth login',
        ])
      }
    }
    expect(skillInstallCommand('claude-code')).toBe('muvloom skill install --host claude-code')
    expect(skillInstallCommand('codex')).toBe('muvloom skill install --host codex')
    expect(skillInstallCommand('other')).toBeNull()
  })

  it('setup.md 公布的安装脚本校验和与仓库里的脚本一致', () => {
    const guide = setupGuide()
    const sh = createHash('sha256')
      .update(readFileSync(resolve(installDir, 'install.sh')))
      .digest('hex')
    const ps1 = createHash('sha256')
      .update(readFileSync(resolve(installDir, 'install.ps1')))
      .digest('hex')
    expect(sh).toBe(INSTALL_SH_SHA256)
    expect(ps1).toBe(INSTALL_PS1_SHA256)
    expect(guide).toContain(sh)
    expect(guide).toContain(ps1)
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
