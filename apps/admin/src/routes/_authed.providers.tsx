import type { ManagedModelsView } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AgentRoutingSettings } from '@/features/agent-models/AgentRoutingSettings'
import { ModelTable, modelsQueryKey } from '@/features/models/ModelTable'
import { UpstreamSecretsPanel } from '@/features/providers/UpstreamSecretsPanel'
import { apiClient } from '@/lib/api-client'

type ProvidersTab = 'settings' | 'secrets'

export const Route = createFileRoute('/_authed/providers')({
  validateSearch: (search: Record<string, unknown>): { tab?: ProvidersTab } =>
    search.tab === 'secrets' ? { tab: 'secrets' } : {},
  component: ProvidersPage,
})

function ProvidersPage() {
  const { tab = 'settings' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const modelsQuery = useQuery({
    queryKey: modelsQueryKey,
    queryFn: () => apiClient.get<ManagedModelsView>('/api/models'),
  })
  const chatModels = (modelsQuery.data?.models ?? []).filter((model) => model.kind === 'chat')
  return (
    <Page crumbs={[{ label: '供应商' }]} description="集中管理 Provider、模型路由与运行时密钥">
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({ search: value === 'secrets' ? { tab: 'secrets' } : {}, replace: true })
        }
      >
        <TabsList>
          <TabsTrigger value="settings">Provider 与模型</TabsTrigger>
          <TabsTrigger value="secrets">运行时密钥</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="flex-row items-baseline justify-between gap-4 space-y-0">
              <CardTitle>对话模型</CardTitle>
              <p className="text-xs text-muted-foreground">{chatModels.length} 个模型</p>
            </CardHeader>
            <CardContent>
              {modelsQuery.isPending ? (
                <PendingState label="加载对话模型" />
              ) : modelsQuery.isError ? (
                <ErrorState label="加载对话模型失败" error={modelsQuery.error} />
              ) : (
                <ModelTable models={chatModels} />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Provider 与产品档位</CardTitle>
            </CardHeader>
            <CardContent>
              <AgentRoutingSettings />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="secrets" className="mt-4">
          <UpstreamSecretsPanel />
        </TabsContent>
      </Tabs>
    </Page>
  )
}
