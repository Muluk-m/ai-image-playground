import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  clearOperatorSetting,
  operatorSettingsQueryKey,
  saveOperatorSetting,
  useOperatorSettings,
} from '@/lib/queries'
import type { OperatorSettingRow, OperatorSettingUnit } from '@/lib/types'

export const Route = createFileRoute('/_authed/operator-settings')({
  component: OperatorSettingsPage,
})

const DOMAIN_LABEL: Record<string, string> = {
  accounts: '账号',
  agent: '智能体',
  billing: '计费',
  generation: '生成',
  sync: '同步',
  quota: '配额',
  cli: '命令行',
}

export function formatSettingValue(value: boolean | number, unit?: OperatorSettingUnit): string {
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  if (unit === 'bytes') {
    if (value % 1024 ** 3 === 0) return `${value / 1024 ** 3} GB`
    if (value % 1024 ** 2 === 0) return `${value / 1024 ** 2} MB`
  }
  if (unit === 'seconds' && value % 60 === 0) return `${value / 60} 分钟`
  return `${value}${unit === 'seconds' ? ' 秒' : unit === 'minutes' ? ' 分钟' : unit === 'tokens' ? ' tokens' : ''}`
}

export function parseSettingInput(value: string, unit?: OperatorSettingUnit): number {
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(gb|mb|分钟|分|秒|s|m)?$/i)
  if (!match) return Number.NaN
  const amount = Number(match[1])
  const suffix = match[2]?.toLowerCase()
  if (unit === 'bytes' && suffix === 'gb') return Math.round(amount * 1024 ** 3)
  if (unit === 'bytes' && suffix === 'mb') return Math.round(amount * 1024 ** 2)
  if (unit === 'seconds' && (suffix === 'm' || suffix === '分钟' || suffix === '分'))
    return Math.round(amount * 60)
  return Math.round(amount)
}

function OperatorSettingsPage() {
  const query = useOperatorSettings()
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const settings = query.data?.settings ?? []
  const grouped = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const visible = settings.filter(
      (row) => !needle || `${row.key} ${row.name}`.toLowerCase().includes(needle),
    )
    return visible.reduce<Record<string, OperatorSettingRow[]>>((result, row) => {
      ;(result[row.domain] ??= []).push(row)
      return result
    }, {})
  }, [search, settings])

  async function save(row: OperatorSettingRow, value: boolean | number, reason: string) {
    setError(null)
    try {
      const result = await saveOperatorSetting(row.key, {
        value,
        reason,
        expectedRevision: row.revision,
      })
      client.setQueryData(operatorSettingsQueryKey, result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，配置版本可能已变化，请刷新')
    }
  }

  async function clear(row: OperatorSettingRow, reason: string) {
    setError(null)
    try {
      const result = await clearOperatorSetting(row.key, {
        reason,
        expectedRevision: row.revision,
      })
      client.setQueryData(operatorSettingsQueryKey, result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清除失败，配置版本可能已变化，请刷新')
    }
  }

  return (
    <Page crumbs={[{ label: '能力与配额' }]} description="查看基线、运营覆盖与当前生效值">
      <div className="space-y-4">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索配置键或中文名"
          aria-label="搜索能力与配额"
        />
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive p-3 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        {query.isPending ? <PendingState label="加载能力与配额" /> : null}
        {query.isError ? <ErrorState label="加载能力与配额失败" error={query.error} /> : null}
        {Object.entries(grouped).map(([domain, rows]) => (
          <section key={domain} aria-labelledby={`domain-${domain}`} className="space-y-2">
            <h2 id={`domain-${domain}`} className="text-base font-semibold">
              {DOMAIN_LABEL[domain] ?? domain}
            </h2>
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="p-3">名称 / 配置键</th>
                    <th className="p-3">基线</th>
                    <th className="p-3">覆盖</th>
                    <th className="p-3">生效</th>
                    <th className="p-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <SettingRowView key={row.key} row={row} onSave={save} onClear={clear} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </Page>
  )
}

function SettingRowView({
  row,
  onSave,
  onClear,
}: {
  row: OperatorSettingRow
  onSave: (row: OperatorSettingRow, value: boolean | number, reason: string) => Promise<void>
  onClear: (row: OperatorSettingRow, reason: string) => Promise<void>
}) {
  const [value, setValue] = useState(String(row.override ?? row.effective))
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  const readOnly = row.editability !== 'hot'
  const parsed = row.kind === 'capability' ? value === 'true' : parseSettingInput(value, row.unit)
  const impact = `这会改变「${row.name}」的生效值，可能影响线上流量或成本。`
  return (
    <tr className="border-b align-top last:border-0">
      <td className="p-3">
        <strong>{row.name}</strong>
        <code className="mt-1 block text-xs text-muted-foreground">{row.key}</code>
        <span className="mt-1 block text-xs text-muted-foreground">{row.description}</span>
        {row.baselineChanged ? (
          <span className="mt-1 block text-xs text-warning">基线已变</span>
        ) : null}
        {row.invalid ? (
          <span className="mt-1 block text-xs text-destructive">
            覆盖无效：{row.invalidReason ?? '已回退基线'}
          </span>
        ) : null}
      </td>
      <td className="p-3">{formatSettingValue(row.baseline, row.unit)}</td>
      <td className="p-3">
        {row.override === null ? '—' : formatSettingValue(row.override, row.unit)}
        {row.reason ? (
          <span className="mt-1 block text-xs text-muted-foreground">原因：{row.reason}</span>
        ) : null}
      </td>
      <td className="p-3 font-medium">{formatSettingValue(row.effective, row.unit)}</td>
      <td className="min-w-[220px] space-y-2 p-3">
        {readOnly ? (
          <span className="text-xs text-muted-foreground">只读（需发布修改）</span>
        ) : (
          <>
            {row.kind === 'capability' ? (
              <select
                aria-label={`${row.name}值`}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                className="h-9 w-full rounded-md border bg-transparent px-2"
              >
                <option value="true">开启</option>
                <option value="false">关闭</option>
              </select>
            ) : (
              <Input
                aria-label={`${row.name}值`}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
            <Input
              aria-label={`${row.name}修改原因`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="修改原因（必填）"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={
                  !reason.trim() || (typeof parsed === 'number' && !Number.isFinite(parsed))
                }
                onClick={() => {
                  if (row.risk && !confirm) {
                    setConfirm(true)
                    return
                  }
                  void onSave(row, parsed, reason.trim())
                }}
              >
                {row.risk && !confirm ? '确认影响后保存' : '保存'}
              </Button>
              {row.override !== null ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!reason.trim()}
                  onClick={() => void onClear(row, reason.trim())}
                >
                  清除覆盖
                </Button>
              ) : null}
            </div>
            {row.risk && confirm ? (
              <div role="alertdialog" className="rounded-md border border-warning p-2 text-xs">
                <p>{impact}</p>
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setConfirm(false)
                    void onSave(row, parsed, reason.trim())
                  }}
                >
                  确认保存
                </Button>
              </div>
            ) : null}
          </>
        )}
      </td>
    </tr>
  )
}
