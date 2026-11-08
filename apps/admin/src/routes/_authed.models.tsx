import type { ManagedModelsView } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ModelTable, modelsQueryKey } from '@/features/models/ModelTable'
import { modelSummary } from '@/features/models/model-state'
import { apiClient } from '@/lib/api-client'

type ModelsSearch = { tab?: 'chat' }

export const Route = createFileRoute('/_authed/models')({
  validateSearch: (search: Record<string, unknown>): ModelsSearch =>
    search.tab === 'chat' ? { tab: 'chat' } : {},
  beforeLoad: ({ search }) => {
    if (search.tab === 'chat') throw redirect({ to: '/providers' })
  },
  component: ModelsPage,
})

function ModelsPage() {
  const query = useQuery({
    queryKey: modelsQueryKey,
    queryFn: () => apiClient.get<ManagedModelsView>('/api/models'),
  })
  const models = query.data?.models ?? []
  const generation = models.filter((model) => model.kind !== 'chat')
  return (
    <Page crumbs={[{ label: '模型' }]}>
      <ModelsCard title="生成模型" query={query} models={generation}>
        <ModelTable title="图片" models={generation.filter((model) => model.kind === 'image')} />
        <ModelTable title="视频" models={generation.filter((model) => model.kind === 'video')} />
      </ModelsCard>
    </Page>
  )
}

function ModelsCard({
  title,
  query,
  models,
  children,
}: {
  title: string
  query: { isPending: boolean; isError: boolean; error: unknown }
  models: ManagedModelsView['models']
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-4 space-y-0">
        <CardTitle>{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{modelSummary(models)}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        {query.isPending ? (
          <PendingState label="加载模型" />
        ) : query.isError ? (
          <ErrorState label="加载模型失败" error={query.error} />
        ) : (
          children
        )}
      </CardContent>
    </Card>
  )
}
