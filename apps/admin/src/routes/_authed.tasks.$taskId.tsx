import { createFileRoute, redirect } from '@tanstack/react-router'

import { apiClient } from '@/lib/api-client'
import type { TaskDetail } from '@/lib/types'

// /tasks/:id 是一个 deeplink：beforeLoad 先 fetch 该 task 拿到 device_id，
// 然后 redirect 到 /devices/<deviceId>?task=<taskId>。所有视图状态归一到
// /devices 详情页的抽屉形态，保持 Query 缓存共享。
export const Route = createFileRoute('/_authed/tasks/$taskId')({
  beforeLoad: async ({ params, context }) => {
    const task = await context.queryClient.ensureQueryData({
      queryKey: ['task', params.taskId],
      queryFn: () => apiClient.get<TaskDetail>(`/api/tasks/${encodeURIComponent(params.taskId)}`),
    })
    if (!task.device_id) {
      // task 存在但 device_id 缺失（VIRTUAL 列计算结果为 null：旧数据 / 异常 payload）
      return
    }
    throw redirect({
      to: '/devices/$deviceId',
      params: { deviceId: task.device_id },
      search: { task: params.taskId },
    })
  },
  component: TaskNotLinkedPage,
})

function TaskNotLinkedPage() {
  const { taskId } = Route.useParams()
  return (
    <div className="mx-auto max-w-md rounded-lg border bg-card p-6 text-center">
      <h2 className="text-base font-semibold">任务无关联设备</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        任务 <span className="font-mono">{taskId}</span> 的 request_payload 中没有 device_id
        字段，无法定位归属设备。
      </p>
    </div>
  )
}
