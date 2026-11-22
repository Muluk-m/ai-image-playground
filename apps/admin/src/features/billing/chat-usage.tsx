import type { ChatUsageSummary } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '../../lib/private-host'
import { Fact } from './account-facts'
import { credits } from './shared'

/** 概览的指标卡与用户详情的事实行读同一份，两处的叫法不会分叉。 */
export const CHAT_USAGE_FIELDS: ReadonlyArray<{ key: keyof ChatUsageSummary; label: string }> = [
  { key: 'input_tokens', label: '输入 token' },
  { key: 'output_tokens', label: '输出 token' },
  { key: 'credits', label: '折算积分' },
  { key: 'turns', label: '已结算轮' },
]

export function useChatUsage(path: string) {
  return useQuery({
    queryKey: ['private-billing', 'chat-usage', path],
    queryFn: () => apiClient.get<ChatUsageSummary>(path),
  })
}

export function ChatUsageFacts({ usage }: { usage: ChatUsageSummary }) {
  return (
    <div>
      {CHAT_USAGE_FIELDS.map(({ key, label }) => (
        <Fact key={key} label={label} value={credits(usage[key])} />
      ))}
    </div>
  )
}
