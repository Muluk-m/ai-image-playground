import { useNavigate } from '@tanstack/react-router'

import { FuzzyTime } from '@/components/FuzzyTime'
import { StatusBadge } from '@/components/StatusBadge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { duration, shortId } from '@/lib/format'
import type { TaskListItem } from '@/lib/types'

interface TaskTableProps {
  tasks: TaskListItem[]
  deviceId: string
}

function extractRequestField<T = unknown>(payload: unknown, key: string): T | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  return (payload as Record<string, unknown>)[key] as T | undefined
}

function extractPrompt(payload: unknown): string {
  const p = extractRequestField<unknown>(payload, 'prompt')
  if (typeof p === 'string') return p
  // gemini-style：contents[0].parts[].text 拼接
  const contents = extractRequestField<unknown[]>(payload, 'contents')
  if (Array.isArray(contents) && contents.length) {
    const parts = (contents[0] as { parts?: unknown[] })?.parts
    if (Array.isArray(parts)) {
      return parts
        .map((p) => (p as { text?: string })?.text)
        .filter((t): t is string => typeof t === 'string')
        .join(' ')
    }
  }
  return ''
}

function extractN(payload: unknown): number | null {
  const n = extractRequestField<number>(payload, 'n')
  return typeof n === 'number' ? n : null
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
              <TableRow
                key={t.id}
                className="cursor-pointer"
                onClick={() => openTask(t.id)}
              >
                <TableCell>
                  <FuzzyTime ts={t.submitted_at} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={t.status} />
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
