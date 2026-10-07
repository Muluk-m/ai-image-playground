import { createFileRoute } from '@tanstack/react-router'
import { ServerLogsBlock } from '@/components/ops/ServerLogsBlock'
import { Page } from '@/components/Page'
import { parseServerLogSearch } from '@/lib/server-log-search'

export const Route = createFileRoute('/_authed/logs')({
  validateSearch: parseServerLogSearch,
  component: ServerLogsPage,
})

function ServerLogsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <Page crumbs={[{ label: '服务端日志' }]} description="BFF / worker · 消息、错误栈与请求关联">
      <ServerLogsBlock
        searchState={search}
        onSearchChange={(next) => {
          void navigate({ search: next, replace: true })
        }}
      />
    </Page>
  )
}
