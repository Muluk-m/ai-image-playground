import type { ServerLogEntry, ServerLogsResult } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { TaskDetailView } from '@/components/TaskDetailView'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { apiClient } from '@/lib/api-client'
import { useAudits, useTask } from '@/lib/queries'
import { cn } from '@/lib/utils'

interface TaskDetailSheetProps {
  taskId: string | undefined
  onOpenChange: (open: boolean) => void
}

export function TaskDetailSheet({ taskId, onOpenChange }: TaskDetailSheetProps) {
  return (
    <Sheet open={!!taskId} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>任务详情</SheetTitle>
        </SheetHeader>
        {taskId ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <TaskDetailView taskId={taskId} />
            </div>
            <TaskDrawerTabs taskId={taskId} />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function TaskDrawerTabs({ taskId }: { taskId: string }) {
  const task = useTask(taskId)
  const logTo = task.data
    ? Math.min(Date.now() + 60_000, (task.data.completed_at ?? task.data.submitted_at) + 60_000)
    : null
  const logFrom =
    task.data && logTo !== null
      ? Math.max(0, task.data.submitted_at - 60_000, logTo - 7 * 86_400_000)
      : null
  const logs = useQuery({
    queryKey: ['task-logs', taskId, logFrom, logTo],
    enabled: logFrom !== null && logTo !== null,
    queryFn: () =>
      apiClient.get<ServerLogsResult>(
        `/api/ops/logs?taskId=${encodeURIComponent(taskId)}&from=${logFrom}&to=${logTo}`,
      ),
  })
  const audits = useAudits({ targetId: taskId })
  const auditRows = audits.data?.pages.flatMap((page) => page.audits) ?? []
  const logEntries = logs.data?.entries ?? []
  const history = task.data ? historyFromTask(task.data) : []
  const tabs = [
    history.length ? { id: 'history', label: `变更历史 ${history.length}` } : null,
    logEntries.length ? { id: 'logs', label: `服务端日志 ${logEntries.length}` } : null,
    auditRows.length ? { id: 'audit', label: `审计 ${auditRows.length}` } : null,
  ].filter((tab): tab is { id: string; label: string } => tab !== null)
  const [active, setActive] = useState('history')
  const current = tabs.some((tab) => tab.id === active) ? active : tabs[0]?.id
  if (!tabs.length || !current) return null
  return (
    <div className="border-t bg-muted/40">
      <div role="tablist" aria-label="任务附加信息" className="flex gap-4 border-b px-5 text-sm">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`task-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={current === tab.id}
            aria-controls={`task-panel-${tab.id}`}
            className={cn(
              'h-9 border-b-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              current === tab.id
                ? 'border-foreground font-medium'
                : 'border-transparent text-muted-foreground',
            )}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`task-panel-${current}`}
        role="tabpanel"
        aria-labelledby={`task-tab-${current}`}
        tabIndex={0}
        className="max-h-40 overflow-y-auto px-5 py-2 text-xs"
      >
        {current === 'history'
          ? history.map((event) => (
              <p key={event.label} className="grid grid-cols-[72px_1fr] gap-2 py-1">
                <span className="font-mono text-muted-foreground">{event.time}</span>
                <span>{event.label}</span>
              </p>
            ))
          : null}
        {current === 'logs'
          ? logEntries.map((entry) => <LogLine key={entry.id} entry={entry} />)
          : null}
        {current === 'audit'
          ? auditRows.map((audit) => (
              <p key={audit.id} className="break-words py-1">
                <span className="font-mono text-muted-foreground">{audit.operator_id}</span>{' '}
                {audit.action}
                {typeof audit.details.reason === 'string' ? ` · ${audit.details.reason}` : ''}
              </p>
            ))
          : null}
      </div>
    </div>
  )
}

function historyFromTask(task: {
  submitted_at: number
  started_at: number | null
  completed_at: number | null
  status: string
  attempt_count: number
  error_type: string | null
}) {
  const clock = (at: number) =>
    new Date(at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  const events = [{ at: task.submitted_at, label: '提交入队' }]
  if (task.started_at) events.push({ at: task.started_at, label: '开始执行' })
  if (task.attempt_count > 1)
    events.push({
      at: task.started_at ?? task.submitted_at,
      label: `已尝试 ${task.attempt_count} 次`,
    })
  if (task.completed_at)
    events.push({
      at: task.completed_at,
      label:
        task.status === 'failed'
          ? `失败${task.error_type ? ` · ${task.error_type}` : ''}`
          : task.status === 'completed'
            ? '完成'
            : task.status,
    })
  return events.map((event) => ({ ...event, time: clock(event.at) }))
}

function LogLine({ entry }: { entry: ServerLogEntry }) {
  return (
    <p className="py-1">
      <span className="font-mono text-muted-foreground">
        {new Date(entry.at).toLocaleTimeString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          hour12: false,
        })}
      </span>{' '}
      <span className="font-mono">{entry.level}</span> {entry.message}
    </p>
  )
}
