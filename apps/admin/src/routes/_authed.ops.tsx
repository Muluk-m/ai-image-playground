import { createFileRoute } from '@tanstack/react-router'

import { OpsBoard } from '@/components/ops/OpsBoard'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { fuzzyTime } from '@/lib/format'
import { useOps } from '@/lib/queries'

export const Route = createFileRoute('/_authed/ops')({ component: OpsPage })

function OpsPage() {
  const query = useOps()
  return (
    <Page
      crumbs={[{ label: '运维看板' }]}
      description={
        query.data
          ? `这套部署现在有没有出事 · 更新于${fuzzyTime(query.data.generated_at)}，每 30 秒刷新`
          : '这套部署现在有没有出事'
      }
    >
      {query.isPending ? (
        <PendingState label="正在查看部署状况" />
      ) : query.isError ? (
        <ErrorState label="运维看板加载失败" error={query.error} />
      ) : (
        <OpsBoard snapshot={query.data} />
      )}
    </Page>
  )
}
