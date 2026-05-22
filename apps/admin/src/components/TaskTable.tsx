import { useNavigate } from '@tanstack/react-router'
import { RotateCcw } from 'lucide-react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { StatusBadge } from '@/components/StatusBadge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { duration, shortId } from '@/lib/format'
import { extractN, extractPrompt } from '@/lib/request-helpers'
import type { TaskListItem } from '@/lib/types'

interface TaskTableProps {
  tasks: TaskListItem[]
  deviceId: string
}

export function TaskTable({ tasks, deviceId: _deviceId }: TaskTableProps) {
  const navigate = useNavigate()

  if (!tasks.length) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        当前范围内无任务
      </div>
    )
  }

  function openTask(taskId: string): void {
    void navigate({
      to: '.',
      search: (prev) => ({ ...(prev ?? {}), task: taskId }),
    })
  }

  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[140px]">提交时间</TableHead>
            <TableHead className="w-[90px]">状态</TableHead>
            <TableHead className="w-[140px]">模型</TableHead>
            <TableHead>Prompt</TableHead>
            <TableHead className="w-[60px] text-right">n</TableHead>
            <TableHead className="w-[80px] text-right">耗时</TableHead>
            <TableHead className="w-[100px]">ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((t) => {
            const prompt = extractPrompt(t.request_payload)
            const n = extractN(t.request_payload)
            return (
              <TableRow key={t.id} className="cursor-pointer" onClick={() => openTask(t.id)}>
                <TableCell>
                  <FuzzyTime ts={t.submitted_at} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={t.status} />
                    {t.attempt_count > 1 ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums">
                            <RotateCcw className="h-3 w-3" />
                            {t.attempt_count}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          已尝试 {t.attempt_count} 次（含首次）
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{t.model}</TableCell>
                <TableCell className="max-w-md">
                  <PromptCell text={prompt} />
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {n ?? '—'}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {duration(t.started_at, t.completed_at)}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-muted-foreground">{shortId(t.id)}</span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function PromptCell({ text }: { text: string }) {
  if (!text) return <span className="text-xs text-muted-foreground">—</span>
  const truncated = text.length > 80 ? `${text.slice(0, 80)}…` : text
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="line-clamp-1 text-xs">{truncated}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-md whitespace-pre-wrap break-words text-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
