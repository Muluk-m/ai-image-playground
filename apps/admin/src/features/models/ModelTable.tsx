import type { ManagedModel, ManagedModelsView } from '@image-playground/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { DangerConfirmDialog } from '@/components/DangerConfirmDialog'
import { FuzzyTime } from '@/components/FuzzyTime'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { apiClient } from '@/lib/api-client'
import { PrivateAdminModelPricing } from '@/lib/private-overlay'
import { cn } from '@/lib/utils'
import { type ModelState, modelState, sortModels } from './model-state'

export const modelsQueryKey = ['models']

const STATE_LABELS: Record<ModelState, string> = {
  active: '上架',
  paused: '自动暂停',
  inactive: '已下架',
}

const STATE_DOTS: Record<ModelState, string> = {
  active: 'bg-success',
  paused: 'bg-warning',
  inactive: 'bg-muted-foreground/40',
}

function ModelStatus({ model }: { model: ManagedModel }) {
  const state = modelState(model)
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', STATE_DOTS[state])} aria-hidden />
        {STATE_LABELS[state]}
      </div>
      {state === 'paused' && model.paused_at ? (
        <div className="mt-0.5 text-xs text-muted-foreground">
          上游无可用账号 · <FuzzyTime ts={model.paused_at} />
        </div>
      ) : null}
    </div>
  )
}

function ModelRow({ model }: { model: ManagedModel }) {
  const client = useQueryClient()
  const [pendingActive, setPendingActive] = useState<boolean | null>(null)
  const mutation = useMutation({
    mutationFn: ({ active, reason }: { active: boolean; reason: string }) =>
      apiClient.put<ManagedModelsView>(`/api/models/${encodeURIComponent(model.id)}`, {
        active,
        reason,
      }),
    onSuccess: (data) => {
      client.setQueryData(modelsQueryKey, data)
      setPendingActive(null)
    },
  })
  const paused = modelState(model) === 'paused'
  const nextActive = pendingActive ?? model.active
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b py-3 last:border-0">
      <div className="w-full min-w-0 sm:w-56">
        <div className="truncate text-sm font-medium" title={model.label}>
          {model.label}
        </div>
        {model.label !== model.id ? (
          <div className="truncate font-mono text-xs text-muted-foreground" title={model.id}>
            {model.id}
          </div>
        ) : null}
      </div>
      <div className="w-40 pt-0.5">
        <ModelStatus model={model} />
      </div>
      <div className="min-w-0 flex-1">
        <PrivateAdminModelPricing model={model.id} kind={model.kind} />
      </div>
      <div className="flex h-9 items-center gap-3">
        {paused ? (
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => setPendingActive(true)}
          >
            恢复上架
          </Button>
        ) : (
          <Switch
            aria-label={`${model.label} 上架`}
            checked={model.active}
            disabled={mutation.isPending}
            onCheckedChange={(checked) => setPendingActive(checked)}
          />
        )}
        <DangerConfirmDialog
          open={pendingActive !== null}
          onOpenChange={(open) => {
            if (!open) setPendingActive(null)
          }}
          title={`${nextActive ? '上架' : '下架'}模型 ${model.label}?`}
          impact={
            nextActive
              ? `${model.label} 会重新出现在模型选择器里。进行中的任务仍按原模型走完。`
              : `${model.label} 会从模型选择器里消失。进行中的任务仍按原模型走完，新的生成不再使用它。`
          }
          versionNote="会写入审计日志。如果期间有人改过配置，刷新后再确认。"
          confirmLabel={nextActive ? '确认上架' : '确认下架'}
          destructive={!nextActive}
          pending={mutation.isPending}
          onConfirm={(reason) => {
            if (pendingActive === null) return
            mutation.mutate({ active: pendingActive, reason })
          }}
        />
        {mutation.isError ? (
          <span role="alert" className="text-xs text-destructive">
            保存失败
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function ModelTable({ title, models }: { title?: string; models: readonly ManagedModel[] }) {
  if (!models.length) return null
  return (
    <section>
      {title ? <h3 className="mb-1 text-sm font-medium text-muted-foreground">{title}</h3> : null}
      {sortModels(models).map((model) => (
        <ModelRow key={model.id} model={model} />
      ))}
    </section>
  )
}
