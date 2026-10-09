import { Copy, FileText, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { currentLocale, useTranslation } from '../../../i18n'
import { formatDateTime, formatNumber } from '../../../i18n/format'
import { copyTextToClipboard } from '../../../lib/clipboard'

const FIELDS = [
  'message',
  'serverMessage',
  'code',
  'occurredAt',
  'durationMs',
  'httpStatus',
  'model',
  'requestId',
  'conversationId',
  'turnId',
  'toolName',
  'toolCallId',
  'taskId',
] as const
const LEGACY_MESSAGE = 'Original upstream error detail was not recorded by this version.'

export default function AgentCopyDiagnostic({ diagnostic }: { diagnostic: object }) {
  const { t } = useTranslation(['agent', 'common'])
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<'copied' | 'copyFailed' | null>(null)
  const record = diagnostic as Record<string, unknown>
  const rows = FIELDS.flatMap((field) => {
    const value = record[field]
    if (value === undefined || value === null || value === '') return []
    let text = typeof value === 'string' ? value : JSON.stringify(value)
    if (field === 'message' && value === LEGACY_MESSAGE) text = t('diagnostic.missing')
    if (field === 'durationMs' && typeof value === 'number') text = `${formatNumber(value)} ms`
    if (field === 'occurredAt' && typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
      const zone = new Intl.DateTimeFormat(currentLocale(), { timeZoneName: 'short' })
        .formatToParts(new Date(value))
        .find((part) => part.type === 'timeZoneName')?.value
      text = `${formatDateTime(value)} ${zone ?? ''}`.trim()
    }
    return [{ key: field, label: t(`diagnostic.fields.${field}`), text }]
  })
  const summary =
    record.code === 'agent_upstream_error'
      ? t('error.upstream')
      : record.code === 'agent_request_budget_exceeded'
        ? t('error.requestBudgetExceeded')
        : record.code === 'agent_context_overflow'
          ? t('error.contextOverflow')
          : record.code === 'agent_tool_failed'
            ? t('error.toolFailed')
            : t('error.turnFailed')
  const raw = JSON.stringify(diagnostic, null, 2)
  const readable = [
    t('diagnostic.title'),
    summary,
    ...rows.map(({ label, text }) => `${label}: ${text}`),
    '',
    t('diagnostic.raw'),
    raw,
  ].join('\n')
  const copy = async (text: string) => {
    try {
      await copyTextToClipboard(text)
      setResult('copied')
    } catch {
      setResult('copyFailed')
    }
  }
  return (
    <Popover
      modal
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        setResult(null)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 hover:bg-foreground/5 focus-visible:ring-foreground"
          aria-label={t('diagnostic.title')}
          title={t('diagnostic.title')}
        >
          <FileText className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only">{t('diagnostic.title')}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t('diagnostic.title')}
        className="border-border bg-card text-foreground z-[1300] max-h-[min(80dvh,640px)] w-[min(480px,calc(100vw-32px))] overflow-y-auto rounded-xl p-4 text-sm"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-semibold">{t('diagnostic.title')}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('action.close', { ns: 'common' })}
            onClick={() => setOpen(false)}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <p className="mb-3 leading-relaxed">{summary}</p>
        {!record.message && <p className="mb-3 text-muted-foreground">{t('diagnostic.unknown')}</p>}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          {rows.map(({ key, label, text }) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {text}
              </dd>
            </div>
          ))}
        </dl>
        <details className="mt-4 rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t('diagnostic.raw')}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs [overflow-wrap:anywhere]">
            {raw}
          </pre>
        </details>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void copy(readable)}>
            <Copy aria-hidden="true" />
            {t('diagnostic.copyDetails')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void copy(raw)}>
            {t('error.copyLog')}
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {result && t(`error.${result}`)}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
