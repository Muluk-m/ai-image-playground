// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginDialog } from '../../auth/LoginDialog'
import { DraftInput } from '../../components/composer/SettingsPanel'
import DetailModal from '../../components/DetailModal'
import ChangelogPage from '../../features/announcements/ChangelogPage'
import { setAnnouncementFeed } from '../../features/announcements/panel'
import CliConnectionsSection from '../../features/cli/CliConnectionsSection'
import InspirationGrid from '../../features/inspiration/components/InspirationGrid'
import { useInspirationStore } from '../../features/inspiration/store'
import NamingDialog from '../../features/library/components/NamingDialog'
import { setLocale } from '../../i18n'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'
import { useStore } from '../../store'
import { DEFAULT_PARAMS, type TaskRecord } from '../../types'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  setLocale('zh-CN')
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://api.example.com' } })
  window.history.replaceState(null, '', '/')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  useStore.setState({ detailTaskId: null, confirmDialog: null })
  useInspirationStore.setState({ items: [], status: 'idle' })
  setAnnouncementFeed({ items: [], unreadCount: 0 })
})

describe('Batch 4 core web UX polish', () => {
  it('LoginDialog uses reset-password CTA for reset_token and shows recovery-specific fallback error', async () => {
    window.history.replaceState(null, '', '/?reset_token=tok-123')
    let resolveReset!: (response: Response) => void
    const pendingReset = new Promise<Response>((resolve) => {
      resolveReset = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/api/auth/oauth/providers')) {
          return Response.json({
            providers: [],
            loginMethods: { password: true, registration: true },
          })
        }
        if (input.includes('/api/auth/password-reset/confirm')) return pendingReset
        return Response.json({})
      }),
    )
    const onClose = vi.fn()
    await act(async () => {
      root.render(<LoginDialog onClose={onClose} />)
    })

    const submit = document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.textContent).toContain('重置密码')
    expect(submit.textContent).not.toContain('发送找回邮件')

    const input = document.body.querySelector<HTMLInputElement>(
      'input[autocomplete="new-password"]',
    )!
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      valueSetter.call(input, 'NewSecret123!')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const form = document.body.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(submit.textContent).toContain('正在重置')
    expect(input.disabled).toBe(true)
    const closeBtn = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="关闭登录框"]',
    )!
    expect(closeBtn.disabled).toBe(true)

    await act(async () => {
      resolveReset(Response.json({ error: 'rate_limited' }, { status: 429 }))
    })
    expect(document.body.textContent).toContain('请求过于频繁，请稍后再试。')
    expect(document.body.textContent).not.toContain('邮箱或密码')
  })

  it('DetailModal keeps detail open when delete confirmation is opened or cancelled', async () => {
    const task: TaskRecord = {
      id: 'task-del-1',
      prompt: '保持弹窗不闪关',
      params: { ...DEFAULT_PARAMS },
      inputImageIds: [],
      maskTargetImageId: null,
      maskImageId: null,
      outputImages: ['img-a', 'img-b'],
      status: 'done',
      error: null,
      createdAt: 1000,
      finishedAt: 2000,
      elapsed: 1000,
    }
    useStore.setState({ tasks: [task], detailTaskId: task.id, confirmDialog: null })

    await act(async () => {
      root.render(<DetailModal />)
    })

    const deleteBtn = Array.from(document.body.querySelectorAll('button')).find(
      (btn) =>
        btn.getAttribute('aria-label')?.includes('删除') || btn.textContent?.includes('删除'),
    )
    expect(deleteBtn).toBeDefined()
    await act(async () => {
      deleteBtn!.click()
    })

    expect(useStore.getState().confirmDialog).not.toBeNull()
    expect(useStore.getState().detailTaskId).toBe(task.id)
  })

  it('CliConnectionsSection requires inline confirmation before revoke and shows retry on load failure', async () => {
    let fetchCount = 0
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Response.json({ ok: true })
      fetchCount += 1
      if (fetchCount === 1) throw new TypeError('offline')
      return Response.json({
        connections: [
          { id: 'cli-abc123', client_name: 'My CLI', created_at: 1, last_used_at: null },
        ],
      })
    })
    vi.stubGlobal('fetch', fetcher)

    await act(async () => {
      root.render(<CliConnectionsSection />)
    })

    const retryBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('重试'),
    )
    expect(retryBtn).toBeDefined()
    await act(async () => {
      retryBtn!.click()
    })
    expect(host.textContent).toContain('My CLI')

    const revokeBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '撤销连接',
    )!
    await act(async () => {
      revokeBtn.click()
    })
    expect(fetcher.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false)

    const cancelBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '取消',
    )!
    await act(async () => {
      cancelBtn.click()
    })
    expect(host.textContent).toContain('撤销连接')
    expect(fetcher.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false)
  })

  it('NamingDialog locks double-submit during async onSave and shows spinner', async () => {
    let resolveSave!: () => void
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        }),
    )
    const onCancel = vi.fn()

    await act(async () => {
      root.render(
        <NamingDialog
          title="重命名"
          placeholder="输入名称"
          defaultName="旧名称"
          onCancel={onCancel}
          onSave={onSave}
        />,
      )
    })

    const saveBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.getAttribute('type') === 'submit',
    )!
    const form = document.body.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(saveBtn.disabled).toBe(true)
    expect(saveBtn.querySelector('.animate-spin')).not.toBeNull()

    await act(async () => {
      resolveSave()
    })
    expect(saveBtn.disabled).toBe(false)
  })

  it('DraftInput reverts on Escape without committing and ignores IME Enter', async () => {
    const onCommit = vi.fn()
    const onBlur = vi.fn()
    await act(async () => {
      root.render(<DraftInput value="1024" onCommit={onCommit} onBlur={onBlur} />)
    })

    const input = host.querySelector('input')!
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      input.focus()
      valueSetter.call(input, '2048')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('2048')

    // IME Enter should not commit
    await act(async () => {
      const imeEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      Object.defineProperty(imeEvent, 'isComposing', { value: true })
      input.dispatchEvent(imeEvent)
    })
    expect(onCommit).not.toHaveBeenCalled()

    // Escape should revert draft and blur without calling onCommit
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(input.value).toBe('1024')
    expect(onCommit).not.toHaveBeenCalled()
    expect(onBlur).toHaveBeenCalledTimes(1)
  })

  it('ChangelogPage shows retry button on error and recovers on click', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('offline')
        return Response.json({ items: [], unreadCount: 0 })
      }),
    )

    await act(async () => {
      root.render(<ChangelogPage />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(host.textContent).toContain('更新没有加载出来')
    const retryBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('重试'),
    )!
    expect(retryBtn).toBeDefined()

    await act(async () => {
      retryBtn.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(host.textContent).toContain('还没有更新')
  })

  it('InspirationGrid renders human-friendly loadFailed message instead of manifest structure jargon', async () => {
    useInspirationStore.setState({ items: [], status: 'error' })
    await act(async () => {
      root.render(<InspirationGrid scroller={null} />)
    })

    expect(host.textContent).toContain('灵感库加载失败，请刷新重试')
    expect(host.textContent).not.toContain('结构无效')
  })
})
