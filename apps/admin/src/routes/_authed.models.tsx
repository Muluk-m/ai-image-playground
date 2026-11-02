import type { ManagedModelsView } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AgentRoutingSettings } from '@/features/agent-models/AgentRoutingSettings'
import { ModelTable, modelsQueryKey } from '@/features/models/ModelTable'
import { modelSummary } from '@/features/models/model-state'
import { apiClient } from '@/lib/api-client'

type ModelsTab = 'generation' | 'chat'

export const Route = createFileRoute('/_authed/models')({
  validateSearch: (search: Record<string, unknown>): { tab?: ModelsTab } =>
    search.tab === 'chat' ? { tab: 'chat' } : {},
  component: ModelsPage,
})

function ModelsPage() {
  const { tab = 'generation' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const query = useQuery({
    queryKey: modelsQueryKey,
    queryFn: () => apiClient.get<ManagedModelsView>('/api/models'),
  })
  const models = query.data?.models ?? []
  const generation = models.filter((model) => model.kind !== 'chat')
  const chat = models.filter((model) => model.kind === 'chat')
  return (
    <Page crumbs={[{ label: '模型' }]}>
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({ search: value === 'chat' ? { tab: 'chat' } : {}, replace: true })
        }
      >
        <TabsList>
          <TabsTrigger value="generation">生成模型</TabsTrigger>
          <TabsTrigger value="chat">对话模型</TabsTrigger>
        </TabsList>
        <TabsContent value="generation" className="mt-4">
          <ModelsCard title="生成模型" query={query} models={generation}>
            <ModelTable
              title="图片"
              models={generation.filter((model) => model.kind === 'image')}
            />
            <ModelTable
              title="视频"
              models={generation.filter((model) => model.kind === 'video')}
            />
          </ModelsCard>
        </TabsContent>
        <TabsContent value="chat" className="mt-4 space-y-4">
          <ModelsCard title="对话模型" query={query} models={chat}>
            <ModelTable models={chat} />
          </ModelsCard>
          <Card>
            <CardHeader>
              <CardTitle>上游与档位</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <AgentRoutingSettings />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
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
