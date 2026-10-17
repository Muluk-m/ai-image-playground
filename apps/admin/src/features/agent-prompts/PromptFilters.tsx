import { useState } from 'react'
import { DateTimePicker } from '@/components/DateTimePicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { type AgentPromptFilters, parseAgentPromptFilters } from '../../../contracts'

const dateText = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, 16)
export function PromptFilters({
  filters,
  onApply,
}: {
  filters: AgentPromptFilters
  onApply: (filters: AgentPromptFilters) => void
}) {
  const [from, setFrom] = useState(dateText(filters.from))
  const [to, setTo] = useState(dateText(filters.to))
  const [q, setQ] = useState(filters.q ?? '')
  const [ownerKind, setOwnerKind] = useState(
    filters.userId ? 'userId' : filters.deviceId ? 'deviceId' : 'all',
  )
  const [owner, setOwner] = useState(filters.userId ?? filters.deviceId ?? '')
  const [edited, setEdited] = useState(filters.edited ?? 'all')
  const [error, setError] = useState('')
  return (
    <form
      aria-label="提示词筛选"
      className="space-y-3 rounded-xl border p-4"
      onSubmit={(event) => {
        event.preventDefault()
        const parsed = parseAgentPromptFilters({
          from: from === dateText(filters.from) ? filters.from : Date.parse(`${from}:00+08:00`),
          to: to === dateText(filters.to) ? filters.to : Date.parse(`${to}:59.999+08:00`),
          status: filters.status,
          edited: edited === 'all' ? undefined : edited,
          ...(ownerKind === 'all' ? {} : { [ownerKind]: owner }),
          q: q.trim() || undefined,
        })
        if (!parsed) {
          setError('请选择有效的归属与时间范围，最多 31 天，结束时间不能在未来。')
          return
        }
        setError('')
        onApply(parsed)
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1 text-xs">
          <span>开始时间（北京时间）</span>
          <DateTimePicker aria-label="开始时间（北京时间）" value={from} onChange={setFrom} />
        </label>
        <label className="space-y-1 text-xs">
          <span>结束时间（北京时间）</span>
          <DateTimePicker aria-label="结束时间（北京时间）" value={to} onChange={setTo} />
        </label>
        <div className="space-y-1 text-xs">
          <span>修改情况</span>
          <Select value={edited} onValueChange={(value) => setEdited(value as typeof edited)}>
            <SelectTrigger aria-label="修改情况">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部修改情况</SelectItem>
              <SelectItem value="true">确认前被改过</SelectItem>
              <SelectItem value="false">未修改</SelectItem>
              <SelectItem value="unknown">原稿未记录</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 text-xs">
          <span>归属类型</span>
          <Select value={ownerKind} onValueChange={setOwnerKind}>
            <SelectTrigger aria-label="归属类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部归属</SelectItem>
              <SelectItem value="userId">用户</SelectItem>
              <SelectItem value="deviceId">匿名设备</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 space-y-1 text-xs">
          <span>提示词关键词</span>
          <Input
            aria-label="提示词关键词"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            maxLength={500}
            placeholder="搜索原稿或提交稿"
          />
        </label>
        {ownerKind !== 'all' ? (
          <label className="min-w-0 flex-1 space-y-1 text-xs">
            <span>{ownerKind === 'userId' ? '用户 ID' : '设备 ID'}</span>
            <Input
              aria-label="归属 ID"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              maxLength={200}
              required
            />
          </label>
        ) : null}
        <Button type="submit" variant="outline">
          应用筛选
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </form>
  )
}
