// @vitest-environment jsdom
import type { AgentToolErrorCode } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { AUTH_SESSION_EXPIRED_EVENT } from '../../../../lib/authClient'
import { notifyPrivateSubmissionError } from '../../../../lib/privateOverlay'

const send = vi.hoisted(() => vi.fn())

vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: { getState: () => ({ send, placeOnCanvas: vi.fn() }) },
}))

const deployment = vi.hoisted(() => ({
  overlay: true,
  capabilities: new Set<string>(['billing:credits', 'accounts:login']),
}))

vi.mock('../../../../lib/privateOverlay', () => ({
  notifyPrivateSubmissionError: vi.fn(),
  get PrivateWebOverlayPresent() {
    return deployment.overlay
  },
}))

vi.mock('../../../../lib/clientCapabilities', () => ({
  isClientCapabilityEnabled: (key: string) => deployment.capabilities.has(key),
}))

beforeEach(() => {
  send.mockClear()
  deployment.overlay = true
  deployment.capabilities = new Set(['billing:credits', 'accounts:login'])
  vi.mocked(notifyPrivateSubmissionError).mockClear()
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('says a submitted background job is still generating and will land on the canvas', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() =>
      root.render(
        <AgentToolCard
          message={{
            kind: 'tool',
            id: 'm',
            turnId: 't',
            toolCallId: 'c',
            title: '一只橘猫',
            status: 'submitted',
          }}
        />,
      ),
    )
    expect(host.textContent).toContain('已在后台生成，完成后自动放入画布')
  } finally {
    act(() => root.unmount())
  }
})
it('keeps the complete multiline prompt available and copies it without the title truncation', async () => {
  const prompt = '完整提示词。'.repeat(30) + '\n第二段细节'
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() =>
      root.render(
        <AgentToolCard
          message={{
            kind: 'tool',
            id: 'm',
            turnId: 't',
            toolCallId: 'c',
            title: '摘要…',
            prompt,
            status: 'running',
          }}
        />,
      ),
    )
    expect(host.textContent).not.toContain('复制')
    expect(host.textContent).not.toContain('存为模板')
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('[aria-label="完整提示词"]')?.textContent).toBe(prompt)
    const copy = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === '复制',
    )!
    await act(async () => copy.click())
    expect(writeText).toHaveBeenCalledWith(prompt)
    expect(dialog.textContent).toContain('已复制')
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭提示词"]')!.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

describe('失败卡按错误码给出路', () => {
  const failed = (errorCode?: AgentToolErrorCode) =>
    ({
      kind: 'tool',
      id: 'm',
      turnId: 't',
      toolCallId: 'c',
      toolName: 'generateImage',
      title: '一只橘猫',
      status: 'failed',
      message: '服务端写的那句话',
      ...(errorCode ? { errorCode } : {}),
    }) as const

  function render(message: ReturnType<typeof failed>) {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<AgentToolCard message={message} />))
    return { host, unmount: () => act(() => root.unmount()) }
  }

  const buttons = (host: HTMLElement) =>
    Array.from(host.querySelectorAll('button')).map((button) => button.textContent)

  it.each([
    ['insufficient_credits', '积分不够，这次没有提交', '去充值'],
    ['quota_exceeded', '今天的生成额度已经用完', '去充值'],
    ['authentication_required', '需要先登录才能生成', '去登录'],
    ['invalid_params', '这次的参数不成立，没有提交', '让助手重新处理'],
    ['model_unavailable', '要用的模型暂时不可用', '让助手重新处理'],
  ] as const)('%s 显示译文与「%s」对应的出路', (code, text, action) => {
    const { host, unmount } = render(failed(code))
    try {
      expect(host.textContent).toContain(text)
      // 界面不读服务端文字（ADR 0006）。
      expect(host.textContent).not.toContain('服务端写的那句话')
      expect(buttons(host)).toEqual([action])
    } finally {
      unmount()
    }
  })

  it.each([
    ['upstream_error', '生成服务出错了，这次没有出来'],
    ['timeout', '生成超时，这次没有出来'],
    ['no_output', '生成完成了，但没有拿到结果'],
    ['result_unknown', '这次的结果没能确认，可能已经生成；请先看看画布与历史'],
    ['cancelled', '已中止'],
    ['unknown', '没有完成'],
  ] as const)('%s 只说原因，这张票不给按钮', (code, text) => {
    const { host, unmount } = render(failed(code))
    try {
      expect(host.textContent).toContain(text)
      expect(buttons(host)).toEqual([])
    } finally {
      unmount()
    }
  })

  it('旧记录没有错误码：照旧显示存下的那句话，不给按钮', () => {
    const { host, unmount } = render(failed())
    try {
      expect(host.textContent).toContain('服务端写的那句话')
      expect(buttons(host)).toEqual([])
    } finally {
      unmount()
    }
  })

  it('「让助手重新处理」替用户发一条说明性消息', () => {
    send.mockClear()
    const { host, unmount } = render(failed('invalid_params'))
    try {
      act(() => host.querySelector('button')!.click())
      expect(send).toHaveBeenCalledWith(
        '「一只橘猫」没有完成：这次的参数不成立，没有提交。请换个做法重新处理。',
      )
    } finally {
      unmount()
    }
  })

  it('「去充值」打开充值入口，「去登录」回到登录', () => {
    const expired = vi.fn()
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    const recharge = render(failed('insufficient_credits'))
    const login = render(failed('authentication_required'))
    try {
      act(() => recharge.host.querySelector('button')!.click())
      expect(notifyPrivateSubmissionError).toHaveBeenCalledWith({ insufficientCredits: true })
      act(() => login.host.querySelector('button')!.click())
      expect(expired).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
    } finally {
      recharge.unmount()
      login.unmount()
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    }
  })

  it.each([
    ['免费构建没有收费 overlay', false, ['billing:credits', 'accounts:login']],
    ['部署没开积分计费', true, ['accounts:login']],
  ] as const)('%s：没有充值入口就只说原因，不给「去充值」', (_case, overlay, capabilities) => {
    deployment.overlay = overlay
    deployment.capabilities = new Set(capabilities)
    for (const code of ['insufficient_credits', 'quota_exceeded'] as const) {
      const { host, unmount } = render(failed(code))
      try {
        expect(buttons(host)).toEqual([])
      } finally {
        unmount()
      }
    }
  })

  it('部署没开账号登录：只说原因，不给「去登录」', () => {
    deployment.capabilities = new Set(['billing:credits'])
    const { host, unmount } = render(failed('authentication_required'))
    try {
      expect(host.textContent).toContain('需要先登录才能生成')
      expect(buttons(host)).toEqual([])
    } finally {
      unmount()
    }
  })
})
