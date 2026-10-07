import { createFileRoute } from '@tanstack/react-router'

import { ServerLogsBlock } from '@/components/ops/ServerLogsBlock'
import { Page } from '@/components/Page'

export const Route = createFileRoute('/_authed/logs')({
  component: ServerLogsPage,
})

function ServerLogsPage() {
  return (
    <Page
      crumbs={[{ label: '服务端日志' }]}
      description="BFF 与 worker 的结构化日志：按级别、事件、请求或任务排查"
    >
      <ServerLogsBlock />
    </Page>
  )
}
