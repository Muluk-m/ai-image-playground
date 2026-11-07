import type { ManagedModelsView } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AgentRoutingSettings } from '@/features/agent-models/AgentRoutingSettings'
import { ModelTable, modelsQueryKey } from '@/features/models/ModelTable'
import { GptDirectPanel } from '@/features/providers/GptDirectPanel'
import { UpstreamSecretsPanel } from '@/features/providers/UpstreamSecretsPanel'
import { apiClient } from '@/lib/api-client'
import { useGptDirect } from '@/lib/queries'

type ProvidersTab = 'settings' | 'secrets' | 'direct'

export const Route = createFileRoute('/_authed/providers')({
  validateSearch: (search: Record<string, unknown>): { tab?: ProvidersTab; days?: 7 | 30 } => ({
    tab: search.tab === 'secrets' || search.tab === 'direct' ? search.tab : undefined,
    days: search.days === '30' || search.days === 30 ? 30 : 7,
  }),
  component: ProvidersPage,
})

function ProvidersPage() {
  const { tab = 'settings', days = 7 } = Route.useSearch()
  const navigate = Route.useNavigate()
  const modelsQuery = useQuery({
    queryKey: modelsQueryKey,
    queryFn: () => apiClient.get<ManagedModelsView>('/api/models'),
  })
  const directQuery = useGptDirect(days, tab === 'direct')
  const chatModels = (modelsQuery.data?.models ?? []).filter((model) => model.kind === 'chat')
  return (
    <Page crumbs={[{ label: '供应商' }]} description="集中管理 Provider、模型路由与运行时密钥">
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === 'direct') {
            void navigate({ search: { tab: 'direct', days }, replace: true })
          } else if (value === 'secrets') {
            void navigate({ search: { tab: 'secrets' }, replace: true })
          } else {
            void navigate({ search: {}, replace: true })
          }
        }}
      >
        <TabsList>
          <TabsTrigger value="settings">Provider 与模型</TabsTrigger>
          <TabsTrigger value="direct">直连与预算</TabsTrigger>
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
        <TabsContent value="direct" className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">直连与预算</h2>
            <SegmentedControl
              options={[
                { value: '7' as const, label: '7 天' },
                { value: '30' as const, label: '30 天' },
              ]}
              value={String(days) as '7' | '30'}
              onChange={(next) =>
                void navigate({
                  search: { tab: 'direct', days: next === '30' ? 30 : 7 },
                  replace: true,
                })
              }
              label="花费范围"
            />
          </div>
          {directQuery.data ? (
            <GptDirectPanel view={directQuery.data} />
          ) : directQuery.isError ? (
            <ErrorState label="直连状态加载失败" error={directQuery.error} />
          ) : (
            <PendingState label="正在读取直连密钥" />
          )}
        </TabsContent>
        <TabsContent value="secrets" className="mt-4">
          <UpstreamSecretsPanel />
        </TabsContent>
      </Tabs>
    </Page>
  )
}
