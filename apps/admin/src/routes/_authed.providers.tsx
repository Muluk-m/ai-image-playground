import type { ManagedModelsView } from '@image-playground/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AgentRoutingSettings,
  agentModelsQueryKey,
} from '@/features/agent-models/AgentRoutingSettings'
import {
  ModelCatalogWorkspace,
  type ModelFilterKind,
  modelsQueryKey,
} from '@/features/models/ModelTable'
import { modelState } from '@/features/models/model-state'
import { ChannelTopologyPanel } from '@/features/providers/ChannelTopologyPanel'
import { GptDirectPanel } from '@/features/providers/GptDirectPanel'
import { UpstreamSecretsPanel } from '@/features/providers/UpstreamSecretsPanel'
import { apiClient } from '@/lib/api-client'
import {
  PrivateAdminBillingPanel,
  usePrivateAdminBillingSettingsEnabled,
} from '@/lib/private-overlay'
import { gptDirectQueryKey, upstreamSecretsQueryKey, useGptDirect } from '@/lib/queries'

export type GatewayTab = 'models' | 'routing' | 'keys' | 'billing'

function normalizeGatewayTab(raw: unknown): GatewayTab | undefined {
  if (raw === 'models' || raw === 'routing' || raw === 'keys' || raw === 'billing') return raw
  if (raw === 'settings') return 'routing'
  if (raw === 'direct' || raw === 'secrets') return 'keys'
  return undefined
}

function normalizeModelKind(raw: unknown): ModelFilterKind | undefined {
  if (raw === 'chat' || raw === 'image' || raw === 'video' || raw === 'paused') return raw
  return undefined
}

export const Route = createFileRoute('/_authed/providers')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: GatewayTab; kind?: ModelFilterKind; days?: 7 | 30 } => ({
    tab: normalizeGatewayTab(search.tab),
    kind: normalizeModelKind(search.kind),
    days: search.days === '30' || search.days === 30 ? 30 : 7,
  }),
  component: GatewayAndBillingPage,
})

function GatewayAndBillingPage() {
  const { tab = 'models', kind = 'all', days = 7 } = Route.useSearch()
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()
  const billingEnabled = usePrivateAdminBillingSettingsEnabled()

  const activeTab: GatewayTab = tab === 'billing' && !billingEnabled ? 'models' : tab

  const modelsQuery = useQuery({
    queryKey: modelsQueryKey,
    queryFn: () => apiClient.get<ManagedModelsView>('/api/models'),
    enabled: activeTab === 'models' || activeTab === 'routing',
  })
  const directQuery = useGptDirect(days, activeTab === 'keys')

  const models = modelsQuery.data?.models ?? []
  const channels = modelsQuery.data?.channels ?? []
  const pausedCount = models.filter((model) => modelState(model) === 'paused').length

  const pageTitle = billingEnabled ? '模型与计费' : '模型与网关'

  const refreshing = modelsQuery.isFetching || directQuery.isFetching

  function refreshAll() {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: modelsQueryKey }),
      queryClient.invalidateQueries({ queryKey: agentModelsQueryKey }),
      queryClient.invalidateQueries({ queryKey: gptDirectQueryKey }),
      queryClient.invalidateQueries({ queryKey: upstreamSecretsQueryKey }),
      queryClient.invalidateQueries({ queryKey: ['private-billing'] }),
    ])
  }

  return (
    <Page
      crumbs={[{ label: pageTitle }]}
      actions={
        <div className="flex items-center gap-2">
          {pausedCount > 0 ? <Badge variant="warning">{pausedCount} 个模型自动暂停</Badge> : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={refreshAll}
          >
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            刷新
          </Button>
        </div>
      }
    >
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const next = value as GatewayTab
          if (next === 'keys') {
            void navigate({ search: { tab: 'keys', days }, replace: true })
          } else if (next === 'models') {
            void navigate({ search: kind !== 'all' ? { kind } : {}, replace: true })
          } else {
            void navigate({ search: { tab: next }, replace: true })
          }
        }}
      >
        <div className="overflow-x-auto">
          <TabsList className="min-w-max">
            <TabsTrigger value="models">
              模型与定价
              {models.length > 0 ? (
                <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                  {models.length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="routing">Agent 路由与渠道</TabsTrigger>
            <TabsTrigger value="keys">密钥池与预算</TabsTrigger>
            {billingEnabled ? (
              <TabsTrigger value="billing" className="gap-1.5">
                <span className="size-1.5 rounded-full bg-private" aria-hidden />
                套餐与收款
              </TabsTrigger>
            ) : null}
          </TabsList>
        </div>

        <TabsContent value="models" className="mt-4">
          {modelsQuery.isPending ? (
            <PendingState label="加载全量模型目录" />
          ) : modelsQuery.isError ? (
            <ErrorState label="加载模型目录失败" error={modelsQuery.error} />
          ) : (
            <ModelCatalogWorkspace
              models={models}
              kind={kind}
              onKindChange={(nextKind) =>
                void navigate({
                  search: nextKind === 'all' ? {} : { tab: 'models', kind: nextKind },
                  replace: true,
                })
              }
            />
          )}
        </TabsContent>

        <TabsContent value="routing" className="mt-4 space-y-4">
          <AgentRoutingSettings />
          {modelsQuery.data ? <ChannelTopologyPanel channels={channels} /> : null}
        </TabsContent>

        <TabsContent value="keys" className="mt-4 space-y-4">
          <UpstreamSecretsPanel />
          {directQuery.data ? (
            <GptDirectPanel
              view={directQuery.data}
              rangeControl={
                <SegmentedControl
                  options={[
                    { value: '7' as const, label: '7 天' },
                    { value: '30' as const, label: '30 天' },
                  ]}
                  value={String(days) as '7' | '30'}
                  onChange={(next) =>
                    void navigate({
                      search: { tab: 'keys', days: next === '30' ? 30 : 7 },
                      replace: true,
                    })
                  }
                  label="花费范围"
                />
              }
            />
          ) : directQuery.isError ? (
            <ErrorState label="直连状态加载失败" error={directQuery.error} />
          ) : (
            <PendingState label="正在读取直连密钥与预算" />
          )}
        </TabsContent>

        {billingEnabled ? (
          <TabsContent value="billing" className="mt-4">
            <PrivateAdminBillingPanel />
          </TabsContent>
        ) : null}
      </Tabs>
    </Page>
  )
}
