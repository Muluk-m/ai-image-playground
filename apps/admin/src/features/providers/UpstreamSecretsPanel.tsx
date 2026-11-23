import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ErrorState, PendingState } from '@/components/Page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
  admin: '后台加密存储',
  env: '部署环境变量',
  unset: '未设置',
} as const

const SLOT_META: Record<UpstreamSecretView['id'], { env: string; scope: string }> = {
  openai_direct: {
    env: 'OPENAI_API_KEY',
    scope: 'OpenAI 生图渠道 · Agent OpenAI Provider',
  },
  gemini: {
    env: 'GEMINI_API_KEY',
    scope: 'Gemini 原生生图渠道',
  },
  vertex: {
    env: 'VERTEX_API_KEY',
    scope: 'Vertex Nano Banana 生图渠道',
  },
  sub2api: {
    env: 'UPSTREAM_API_KEY',
    scope: 'sub2api 网关 · 默认 Agent 对话与 GPT 双通道兜底',
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
  if (query.isError) return <ErrorState label="加载上游密钥失败" error={query.error} />
  return <UpstreamSecretList data={query.data} />
}

function UpstreamSecretList({ data }: { data: UpstreamSecretsResult }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <CardTitle className="text-base">上游运行时密钥槽位</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              以 AES-256-GCM 写入数据库并在 10 秒内热同步到全部 BFF / Worker
              节点，密钥明文永不回显。
            </p>
          </div>
          <Badge variant={data.writable ? 'outline' : 'warning'}>
            {data.writable ? '可在线热替换' : '只读模式'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
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
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null)

  function apply(next: UpstreamSecretsResult) {
    client.setQueryData(upstreamSecretsQueryKey, next)
    setDraft('')
    setError(null)
  }

  async function save() {
    const apiKey = draft.trim()
    if (!writable || !apiKey || pending) return
    setPending('save')
    setError(null)
    setProbe(null)
    await enqueueWrite(async () => {
      try {
        apply(await replaceUpstreamSecret(secret.id, apiKey))
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
    setProbe(null)
    await enqueueWrite(async () => {
      try {
        apply(await clearUpstreamSecret(secret.id))
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
    SOURCE_LABEL[secret.source],
    secret.updatedAt ? isoTime(secret.updatedAt) : '',
    secret.updatedBy ?? '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{secret.label}</h3>
            {slotInfo ? (
              <span className="rounded border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {slotInfo.env}
              </span>
            ) : null}
          </div>
          {slotInfo ? <p className="mt-1 text-xs text-muted-foreground">{slotInfo.scope}</p> : null}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium">
          <span
            className={cn(
              'size-2 rounded-full',
              secret.configured ? 'bg-success' : 'bg-muted-foreground/40',
            )}
            aria-hidden
          />
          <span className={secret.configured ? 'text-foreground' : 'text-muted-foreground'}>
            {secret.configured ? '已配置' : '未配置'}
          </span>
        </span>
      </div>

      <p className="text-xs text-muted-foreground">{meta}</p>

      <form
        className="space-y-2.5"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Input
          type="password"
          name={`upstream-secret-${secret.id}`}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={draft}
          placeholder="输入新密钥覆盖…"
          aria-label={`${secret.label} 新密钥`}
          onChange={(event) => {
            setDraft(event.target.value)
            setProbe(null)
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!draft.trim() || pending !== null}
            onClick={() => void test()}
          >
            {pending === 'test' ? '测试中' : '测试连接'}
          </Button>
          <Button type="submit" size="sm" disabled={!writable || !draft.trim() || pending !== null}>
            {pending === 'save' ? '保存中' : '保存'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={secret.source !== 'admin' || pending !== null}
            onClick={() => void clear()}
          >
            {pending === 'clear' ? '清除中' : '清除'}
          </Button>
          {probe ? (
            <span className={cn('text-xs font-medium', probe.ok ? 'text-success' : 'text-danger')}>
              {probe.text}
            </span>
          ) : null}
        </div>
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </form>
    </div>
  )
}
