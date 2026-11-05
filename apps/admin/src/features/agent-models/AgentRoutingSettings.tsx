import type { AgentModelSettings, AgentModelSettingsView } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { DangerConfirmDialog } from '@/components/DangerConfirmDialog'
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
  const [confirming, setConfirming] = useState<null | {
    settings: AgentModelSettings
    revision: number
    resolve: (value: AgentModelSettingsView | undefined) => void
  }>(null)
  const update = useMutation({
    mutationFn: ({
      settings,
      revision,
      reason,
    }: {
      settings: AgentModelSettings
      revision: number
      reason: string
    }) =>
      apiClient.put<AgentModelSettingsView>('/api/agent-models', {
        revision,
        settings,
        reason,
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
          const confirmed = await new Promise<AgentModelSettingsView | undefined>((resolve) => {
            setConfirming({ settings, revision, resolve })
          })
          return confirmed
        }}
      />
      <DangerConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            confirming?.resolve(undefined)
            setConfirming(null)
          }
        }}
        title="保存 Agent 模型配置?"
        impact="保存后从下一轮对话生效。进行中的对话轮保持原配置。"
        versionNote={
          confirming
            ? `基于配置版本 #${confirming.revision}。提交后生成 #${confirming.revision + 1}。`
            : undefined
        }
        confirmLabel="确认保存"
        destructive={false}
        pending={update.isPending}
        onConfirm={(reason) => {
          if (!confirming) return
          void update
            .mutateAsync({ settings: confirming.settings, revision: confirming.revision, reason })
            .then((saved) => {
              confirming.resolve(saved)
              setConfirming(null)
            })
            .catch(() => {
              confirming.resolve(undefined)
              setConfirming(null)
            })
        }}
      />
    </>
  )
}
