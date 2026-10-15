import type { AgentModelSettings, AgentModelSettingsView } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { AgentModelSettingsForm } from '@/features/agent-models/AgentModelSettingsForm'
import { ApiError, apiClient } from '@/lib/api-client'

export const Route = createFileRoute('/_authed/agent-models')({ component: AgentModelsPage })
const queryKey = ['agent-models']

function AgentModelsPage() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey,
    queryFn: () => apiClient.get<AgentModelSettingsView>('/api/agent-models'),
    refetchOnWindowFocus: false,
  })
  const [saved, setSaved] = useState(false)
  const update = useMutation({
    mutationFn: (settings: AgentModelSettings) =>
      apiClient.put<AgentModelSettingsView>('/api/agent-models', {
        revision: query.data?.revision,
        settings,
      }),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data)
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
  return (
    <Page crumbs={[{ label: 'Agent 模型' }]} description="管理 Pi Provider、模型与产品档位的映射">
      {query.isPending ? (
        <PendingState label="加载模型配置" />
      ) : query.isError ? (
        <ErrorState label="加载模型配置失败" error={query.error} />
      ) : (
        <>
          {saved ? (
            <p role="status" className="text-sm text-muted-foreground">
              配置已保存，下一轮对话将使用新配置。
            </p>
          ) : null}
          <AgentModelSettingsForm
            key={query.data.revision}
            initial={query.data}
            pending={update.isPending}
            error={error}
            save={async (settings) => {
              setSaved(false)
              try {
                await update.mutateAsync(settings)
              } catch {
                /* The mutation error is rendered above the save button. */
              }
            }}
          />
        </>
      )}
    </Page>
  )
}
