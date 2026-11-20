// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../../auth/AuthContext'
import FeedbackDialog from '../../../features/feedback/FeedbackDialog'

const clientMock = vi.hoisted(() => ({
  fetchFeedbackThread: vi.fn(),
  markFeedbackRead: vi.fn(),
  sendFeedbackMessage: vi.fn(),
  fetchFeedbackAttachmentBlobUrl: vi.fn(),
}))

vi.mock('../../../features/feedback/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../features/feedback/client')>()),
  fetchFeedbackThread: clientMock.fetchFeedbackThread,
  markFeedbackRead: clientMock.markFeedbackRead,
  sendFeedbackMessage: clientMock.sendFeedbackMessage,
  fetchFeedbackAttachmentBlobUrl: clientMock.fetchFeedbackAttachmentBlobUrl,
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  clientMock.fetchFeedbackThread.mockReset()
  clientMock.markFeedbackRead.mockReset()
  clientMock.sendFeedbackMessage.mockReset()
  clientMock.fetchFeedbackAttachmentBlobUrl.mockReset()
  clientMock.markFeedbackRead.mockResolvedValue({ unreadReplyCount: 0 })
  clientMock.fetchFeedbackAttachmentBlobUrl.mockResolvedValue('blob:mock-preview')

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:local-file'),
    revokeObjectURL: vi.fn(),
  })

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('FeedbackDialog', () => {
  it('sends text and a screenshot from the empty conversation', async () => {
    clientMock.fetchFeedbackThread.mockResolvedValue({ thread: null, messages: [], hasMore: false })
    clientMock.sendFeedbackMessage.mockResolvedValue({
      thread: { id: 't1', status: 'open', unreadReplyCount: 0, updatedAt: 1_795_000_000_000 },
      message: {
        id: 'm1',
        threadId: 't1',
        senderType: 'user',
        senderLabel: null,
        body: '导出分辨率有问题',
        attachment: { mimeType: 'image/png', bytes: 1024, filename: 'shot.png' },
        createdAt: 1_795_000_000_000,
      },
    })

    const onUnreadChange = vi.fn()
    await act(async () => {
      root.render(
        <AuthContextProvider
          value={{
            enabled: true,
            user: { id: 'u1', username: 'alice@example.com' },
            login: vi.fn(),
            logout: vi.fn(async () => {}),
          }}
        >
          <FeedbackDialog onClose={vi.fn()} onUnreadChange={onUnreadChange} />
        </AuthContextProvider>,
      )
    })

    expect(document.body.textContent).toContain('开始会话')

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const pngFile = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', {
      type: 'image/png',
    })

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, '导出分辨率有问题')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      Object.defineProperty(fileInput, 'files', { value: [pngFile], configurable: true })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(document.body.textContent).toContain('shot.png')
    expect(clientMock.fetchFeedbackAttachmentBlobUrl).not.toHaveBeenCalled()

    const sendButton = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '发送',
    )!
    await act(async () => {
      sendButton.click()
    })

    expect(clientMock.sendFeedbackMessage).toHaveBeenCalledWith({
      body: '导出分辨率有问题',
      attachment: pngFile,
    })
    expect(document.body.textContent).toContain('导出分辨率有问题')
    expect(onUnreadChange).toHaveBeenCalled()
  })

  it('rejects unsupported file types before sending', async () => {
    clientMock.fetchFeedbackThread.mockResolvedValue({ thread: null, messages: [], hasMore: false })

    await act(async () => {
      root.render(
        <AuthContextProvider
          value={{
            enabled: true,
            user: { id: 'u1', username: 'alice@example.com' },
            login: vi.fn(),
            logout: vi.fn(async () => {}),
          }}
        >
          <FeedbackDialog onClose={vi.fn()} />
        </AuthContextProvider>,
      )
    })

    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const gifFile = new File([new Uint8Array([71, 73, 70])], 'anim.gif', { type: 'image/gif' })
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [gifFile], configurable: true })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      '仅支持 PNG、JPEG 或 WebP',
    )
  })

  it('prompts guest users to sign in without loading or sending feedback', async () => {
    const login = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(
        <AuthContextProvider
          value={{
            enabled: true,
            user: null,
            login,
            logout: vi.fn(async () => {}),
          }}
        >
          <FeedbackDialog onClose={onClose} />
        </AuthContextProvider>,
      )
    })

    expect(document.body.textContent).toContain('登录后发送反馈')
    expect(document.querySelector('textarea')).toBeNull()
    expect(clientMock.fetchFeedbackThread).not.toHaveBeenCalled()

    const loginBtn = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '登录',
    )!
    act(() => loginBtn.click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(login).toHaveBeenCalledOnce()
  })
})
