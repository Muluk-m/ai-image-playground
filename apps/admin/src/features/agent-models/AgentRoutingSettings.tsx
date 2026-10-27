import type { AgentModelSettings, AgentModelSettingsView } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ErrorState, PendingState } from '@/components/Page'
import { ApiError, apiClient } from '@/lib/api-client'
import { AgentModelSettingsForm } from './AgentModelSettingsForm'

const queryKey = ['agent-models']

/** Pi Provider、模型与产品档位的映射。保存后对话模型清单可能变了，模型列表跟着重取。 */
export function AgentRoutingSettings() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey,
    queryFn: () => apiClient.get<AgentModelSettingsView>('/api/agent-models'),
    refetchOnWindowFocus: false,
  })
  const [saved, setSaved] = useState(false)
  const update = useMutation({
    mutationFn: ({ settings, revision }: { settings: AgentModelSettings; revision: number }) =>
      apiClient.put<AgentModelSettingsView>('/api/agent-models', {
        revision,
        settings,
      }),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data)
      void client.invalidateQueries({ queryKey: ['models'] })
      setSaved(true)
    },
  })
  const error =
    update.error instanceof ApiError &&
    typeof update.error.body === 'object' &&
    update.error.body &&
    'error' in update.error.body
      ? String(update.error.body.error)
      : update.error
        ? '保存失败，请稍后重试'
        : null
  if (query.isPending) return <PendingState label="加载模型配置" />
  if (query.isError) return <ErrorState label="加载模型配置失败" error={query.error} />
  return (
    <>
      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          配置已保存，下一轮对话将使用新配置。
        </p>
      ) : null}
      <AgentModelSettingsForm
        initial={query.data}
        pending={update.isPending}
        error={error}
        save={async (settings, revision) => {
          setSaved(false)
          try {
            return await update.mutateAsync({ settings, revision })
          } catch {
            /* The mutation error is rendered above the save button. */
          }
        }}
      />
    </>
  )
}
