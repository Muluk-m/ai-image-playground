import type {
  AgentModelProbeResult,
  AgentModelSettings,
  AgentModelSettingsView,
  AgentProfileKey,
} from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { DangerConfirmDialog } from '@/components/DangerConfirmDialog'
import { ErrorState, PendingState } from '@/components/Page'
import { ApiError, apiClient } from '@/lib/api-client'
import { AgentModelSettingsForm } from './AgentModelSettingsForm'

export const agentModelsQueryKey = ['agent-models']

const SAFE_VALIDATION_MESSAGES = new Set([
  '请填写原因',
  '配置版本无效',
  '模型设置无效',
  '路由绑定无效',
  '所选 Provider 不存在',
  '未知档位',
  '探测请求无效',
])

function formatSaveError(error: unknown): string | null {
  if (!error) return null
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return '登录状态已失效或无操作权限，请重新登录'
    }
    if (error.status === 409) {
      return '配置已被其他人更新，请刷新后重试'
    }
    const raw =
      typeof error.body === 'object' &&
      error.body &&
      'error' in error.body &&
      typeof error.body.error === 'string'
        ? error.body.error.trim()
        : ''
    if (raw === 'stale_revision') return '配置已被其他人更新，请刷新后重试'
    if (raw === 'forbidden' || raw === 'unauthorized') {
      return '登录状态已失效或无操作权限，请重新登录'
    }
    if (raw === 'invalid_request' || raw === 'validation_error') {
      return '配置项格式无效，请检查后重试'
    }
    const preflightMatch = /^档位\s+([a-z0-9_-]+)\s+预检失败/i.exec(raw)
    if (preflightMatch) {
      return `档位 ${preflightMatch[1]} 预检失败，请先使用「测试连接」检查模型与密钥配置`
    }
    if (SAFE_VALIDATION_MESSAGES.has(raw)) {
      return raw
    }
    if (error.status === 400) {
      return '配置项校验未通过，请检查各档位与 Provider 设置后重试'
    }
  }
  return '保存失败，请稍后重试'
}

/** Pi Provider、模型与产品档位的映射。保存后对话模型清单可能变了，模型列表跟着重取。 */
export function AgentRoutingSettings() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: agentModelsQueryKey,
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
      client.setQueryData(agentModelsQueryKey, data)
      void client.invalidateQueries({ queryKey: ['models'] })
      setSaved(true)
    },
  })
  const error = formatSaveError(update.error)
  if (query.isPending) return <PendingState label="加载模型配置" />
  if (query.isError) return <ErrorState label="加载模型配置失败" error={query.error} />
  return (
    <>
      {saved ? (
        <p
          role="status"
          className="mb-3 rounded-lg border border-success/30 bg-success/10 px-4 py-2.5 text-sm text-success"
        >
          配置已保存，下一轮对话将使用新配置。
        </p>
      ) : null}
      <AgentModelSettingsForm
        initial={query.data}
        pending={update.isPending}
        error={error}
        probe={(settings: AgentModelSettings, profile: AgentProfileKey, target) =>
          apiClient.post<AgentModelProbeResult>('/api/agent-models/probe', {
            settings,
            profile,
            target,
          })
        }
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
