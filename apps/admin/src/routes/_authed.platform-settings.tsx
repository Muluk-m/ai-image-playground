import type { ManagedModelsView } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ModelTable, modelsQueryKey } from '@/features/models/ModelTable'
import { OperatorSettingsPanel } from '@/features/platform-settings/OperatorSettingsPanel'
import { apiClient } from '@/lib/api-client'

type PlatformTab = 'models' | 'settings'

export const Route = createFileRoute('/_authed/platform-settings')({
  validateSearch: (search: Record<string, unknown>): { tab?: PlatformTab } => ({
    tab: search.tab === 'settings' ? 'settings' : 'models',
  }),
  component: PlatformSettingsPage,
})

function PlatformSettingsPage() {
  const { tab = 'models' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const modelsQuery = useQuery({
    queryKey: modelsQueryKey,
    queryFn: () => apiClient.get<ManagedModelsView>('/api/models'),
  })
  const generation = (modelsQuery.data?.models ?? []).filter((model) => model.kind !== 'chat')
  return (
    <Page crumbs={[{ label: '平台配置' }]} description="管理模型可用性、能力开关与运营配额">
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({ search: { tab: value as PlatformTab }, replace: true })
        }
      >
        <TabsList>
          <TabsTrigger value="models">生成模型</TabsTrigger>
          <TabsTrigger value="settings">能力与配额</TabsTrigger>
        </TabsList>
        <TabsContent value="models" className="mt-4">
          {modelsQuery.isPending ? (
            <PendingState label="加载模型" />
          ) : modelsQuery.isError ? (
            <ErrorState label="加载模型失败" error={modelsQuery.error} />
          ) : (
            <div className="space-y-6 rounded-xl border p-4">
              <div>
                <h2 className="text-base font-semibold">生成模型</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  上下架只影响新的模型选择，进行中的任务仍按原模型继续。
                </p>
              </div>
              <ModelTable
                title="图片"
                models={generation.filter((model) => model.kind === 'image')}
              />
              <ModelTable
                title="视频"
                models={generation.filter((model) => model.kind === 'video')}
              />
            </div>
          )}
        </TabsContent>
        <TabsContent value="settings" className="mt-4 rounded-xl border p-4">
          <OperatorSettingsPanel />
        </TabsContent>
      </Tabs>
    </Page>
  )
}
