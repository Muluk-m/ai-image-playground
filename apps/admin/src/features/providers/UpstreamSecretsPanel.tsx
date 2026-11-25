import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { ErrorState, PendingState } from '@/components/Page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { modelsQueryKey } from '@/features/models/ModelTable'
import { ApiError } from '@/lib/api-client'
import { isoTime } from '@/lib/format'
import {
  clearUpstreamSecret,
  replaceUpstreamSecret,
  testUpstreamSecret,
  type UpstreamSecretsResult,
  type UpstreamSecretView,
  upstreamSecretsQueryKey,
  useUpstreamSecrets,
} from '@/lib/queries'
import { cn } from '@/lib/utils'

const SOURCE_LABEL = {
  admin: '后台加密',
  env: '环境变量',
  unset: '未设置',
} as const

const SLOT_META: Record<UpstreamSecretView['id'], { env: string; scope: string }> = {
  openai_direct: {
    env: 'OPENAI_API_KEY',
    scope: 'OpenAI 生图 · Agent OpenAI',
  },
  gemini: {
    env: 'GEMINI_API_KEY',
    scope: 'Gemini 原生生图',
  },
  vertex: {
    env: 'VERTEX_API_KEY',
    scope: 'Vertex Nano Banana',
  },
  sub2api: {
    env: 'UPSTREAM_API_KEY',
    scope: 'sub2api 网关 · 默认对话与兜底',
  },
}

function failureMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return '操作失败，请稍后重试'
  const body = cause.body as { error?: string; message?: string } | null
  if (body?.error === 'master_key_missing' || body?.error === 'master_key_invalid') {
    return body.message || '主密钥未配置，不能写入'
  }
  if (body?.error === 'invalid_secret') return '密钥无效'
  if (body?.error === 'unknown_slot') return '未知密钥'
  return '操作失败，请稍后重试'
}

export function UpstreamSecretsPanel() {
  const query = useUpstreamSecrets()
  if (query.isPending) return <PendingState label="加载上游密钥" />
  if (query.isError)
    return (
      <ErrorState
        label="加载上游密钥失败"
        error={query.error}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    )
  return <UpstreamSecretList data={query.data} />
}

function UpstreamSecretList({ data }: { data: UpstreamSecretsResult }) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base">上游运行时密钥</CardTitle>
        <Badge variant={data.writable ? 'outline' : 'warning'}>
          {data.writable ? 'AES-256 热同步' : '只读模式'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.disabledReason ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            {data.disabledReason}
          </p>
        ) : null}
        {data.warning ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            {data.warning}
          </p>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {data.secrets.map((secret) => (
            <SecretCard key={secret.id} secret={secret} writable={data.writable} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

let writeQueue = Promise.resolve()

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function SecretCard({ secret, writable }: { secret: UpstreamSecretView; writable: boolean }) {
  const client = useQueryClient()
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<'save' | 'clear' | 'test' | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null)

  function apply(next: UpstreamSecretsResult, message: string) {
    client.setQueryData(upstreamSecretsQueryKey, next)
    void client.invalidateQueries?.({ queryKey: modelsQueryKey })
    void client.invalidateQueries?.({ queryKey: ['agent-models'] })
    setDraft('')
    setError(null)
    setNotice(message)
  }

  async function save() {
    const apiKey = draft.trim()
    if (!writable || !apiKey || pending) return
    setPending('save')
    setError(null)
    setNotice(null)
    setProbe(null)
    await enqueueWrite(async () => {
      try {
        apply(await replaceUpstreamSecret(secret.id, apiKey), '已保存并生效')
      } catch (cause) {
        setError(failureMessage(cause))
      } finally {
        setPending(null)
      }
    })
  }

  async function clear() {
    if (secret.source !== 'admin' || pending) return
    setPending('clear')
    setError(null)
    setNotice(null)
    setProbe(null)
    await enqueueWrite(async () => {
      try {
        apply(await clearUpstreamSecret(secret.id), '已清除后台密钥')
        setConfirmClear(false)
      } catch (cause) {
        setError(failureMessage(cause))
      } finally {
        setPending(null)
      }
    })
  }

  async function test() {
    const apiKey = draft.trim()
    if (!apiKey || pending) return
    setPending('test')
    setError(null)
    setProbe(null)
    try {
      const result = await testUpstreamSecret(secret.id, apiKey)
      setProbe({
        ok: result.ok,
        text: result.ok
          ? '连接成功'
          : result.httpStatus
            ? `连接失败 ${result.httpStatus}`
            : '连接失败',
      })
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setPending(null)
    }
  }

  const slotInfo = SLOT_META[secret.id]
  const meta = [
    slotInfo?.scope,
    SOURCE_LABEL[secret.source],
    secret.updatedAt ? isoTime(secret.updatedAt) : '',
    secret.updatedBy ?? '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="space-y-2.5 rounded-xl border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{secret.label}</h3>
            {slotInfo ? (
              <span className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {slotInfo.env}
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={meta}>
            {meta}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              secret.configured ? 'bg-success' : 'bg-muted-foreground/40',
            )}
            aria-hidden
          />
          <span className={secret.configured ? 'text-foreground' : 'text-muted-foreground'}>
            {secret.configured ? '已配置' : '未配置'}
          </span>
        </span>
      </div>

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            name={`upstream-secret-${secret.id}`}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={draft}
            placeholder="输入新密钥覆盖…"
            aria-label={`${secret.label} 新密钥`}
            className="h-8 min-w-[180px] flex-1 text-xs"
            onChange={(event) => {
              setDraft(event.target.value)
              setProbe(null)
            }}
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!draft.trim() || pending !== null}
              onClick={() => void test()}
            >
              {pending === 'test' ? '测试中' : '测试连接'}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!writable || !draft.trim() || pending !== null}
            >
              {pending === 'save' ? '保存中' : '保存'}
            </Button>
            {secret.source === 'admin' ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                className="text-muted-foreground hover:text-danger"
                onClick={() => setConfirmClear(true)}
              >
                {pending === 'clear' ? '清除中' : '清除'}
              </Button>
            ) : null}
          </div>
        </div>
        {notice ? (
          <p role="status" className="text-xs font-medium text-success">
            {notice}
          </p>
        ) : null}
        {probe ? (
          <p className={cn('text-xs font-medium', probe.ok ? 'text-success' : 'text-danger')}>
            {probe.text}
          </p>
        ) : null}
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </form>
      <Dialog
        open={confirmClear}
        onOpenChange={(next) => {
          if (!next && pending === 'clear') return
          setConfirmClear(next)
          if (!next) setError(null)
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onEscapeKeyDown={(event) => {
            if (pending === 'clear') event.preventDefault()
          }}
          onPointerDownOutside={(event) => {
            if (pending === 'clear') event.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>清除 {secret.label} 后台密钥？</DialogTitle>
          </DialogHeader>
          <p className="text-sm leading-6 text-muted-foreground">
            清除后将移除后台加密存储的密钥，
            {slotInfo ? (
              <>
                回退到服务器环境变量 <code className="font-mono">{slotInfo.env}</code>
                （若未配置环境变量则该通道将不可用）。
              </>
            ) : (
              '回退到服务器环境变量配置（若未配置环境变量则该通道将不可用）。'
            )}
          </p>
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmClear(false)}
              disabled={pending !== null}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void clear()}
              disabled={pending !== null}
              aria-busy={pending === 'clear'}
            >
              {pending === 'clear' ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {pending === 'clear' ? '清除中…' : '确认清除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
