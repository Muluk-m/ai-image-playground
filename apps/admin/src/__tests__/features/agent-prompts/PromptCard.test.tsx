// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentPromptItem } from '../../../../contracts'
import { PromptCard } from '../../../features/agent-prompts/PromptCard'
import { PromptSummary } from '../../../features/agent-prompts/PromptSummary'

const copy = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('../../../lib/format', () => ({ copyText: copy, shortId: (id: string) => id.slice(0, 8) }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ params, children }: { params: { userId: string }; children: ReactNode }) => (
    <a href={`/users/${params.userId}`}>{children}</a>
  ),
}))
const item: AgentPromptItem = {
  id: 'draft',
  kind: 'draft',
  createdAt: 1000,
  conversationId: 'conversation',
  turnId: 'turn',
  userId: 'user-1',
  deviceId: null,
  username: '测试用户',
  prompt: '蓝色杯子',
  draftedPrompt: '绿色杯子',
  edited: true,
  status: 'completed',
  tool: 'generate_image',
  media: 'image',
  model: 'image-model',
  taskId: 'task-1',
  userText: '生成绿色杯子',
  chatModel: 'chat-model',
  inputTokens: 12,
  outputTokens: 5,
}
describe('PromptCard', () => {
  it('shows edited original, context, owner and opens the existing task', async () => {
    const onTask = vi.fn()
    const { container } = render(<PromptCard item={item} onTask={onTask} />)
    expect(container.querySelector('del')?.textContent).toBe('绿')
    expect(container.querySelector('ins')?.textContent).toBe('蓝')
    expect(screen.getByText('生成绿色杯子')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '测试用户' })).toHaveAttribute('href', '/users/user-1')
    fireEvent.click(screen.getByRole('button', { name: '查看任务' }))
    expect(onTask).toHaveBeenCalledWith('task-1')
    fireEvent.click(screen.getByRole('button', { name: '复制提示词' }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith('蓝色杯子'))
    expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument()
  })
  it.each([
    ['awaiting', '待确认'],
    ['running', '生成中'],
    ['completed', '已完成'],
    ['failed', '失败 / 取消'],
  ] as const)('renders %s without a missing-original diff', (status, label) => {
    const { container } = render(
      <PromptCard
        item={{
          ...item,
          status,
          draftedPrompt: null,
          edited: null,
          taskId: status === 'awaiting' ? null : 'task-1',
          userText: null,
          userId: null,
          deviceId: 'device-1',
        }}
        onTask={() => {}}
      />,
    )
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText('原稿未记录')).toBeInTheDocument()
    expect(screen.getByText('后台唤醒（无用户原话）')).toBeInTheDocument()
    expect(container.querySelector('del')).toBeNull()
    if (status === 'awaiting') expect(screen.queryByRole('button', { name: '查看任务' })).toBeNull()
  })
  it('escapes prompt markup instead of executing or rendering it', () => {
    const { container } = render(
      <PromptCard
        item={{ ...item, prompt: '<script>alert(1)</script>', draftedPrompt: null, edited: null }}
        onTask={() => {}}
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
  })
  it('uses only recorded originals for edit ratio and submitted rows for failure ratio', () => {
    render(
      <PromptSummary
        summary={{ total: 10, knownOriginal: 4, edited: 1, awaiting: 2, submitted: 8, failed: 1 }}
      />,
    )
    expect(screen.getByText('25.0%')).toBeInTheDocument()
    expect(screen.getByText('12.5%')).toBeInTheDocument()
    expect(screen.getByText('1 / 4 条已记录原稿')).toBeInTheDocument()
  })
})
