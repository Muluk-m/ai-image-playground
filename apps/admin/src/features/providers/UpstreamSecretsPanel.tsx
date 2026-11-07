import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ErrorState, PendingState } from '@/components/Page'
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

const SOURCE_LABEL = {
  admin: '后台',
  env: '环境变量',
  unset: '未设置',
} as const

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
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">上游密钥</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          管理生成与 Agent 使用的运行时密钥。密钥只写入后端，不会回显。
        </p>
      </div>
      {data.disabledReason ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          {data.disabledReason}
        </p>
      ) : null}
      {data.warning ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          {data.warning}
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.secrets.map((secret) => (
          <SecretCard key={secret.id} secret={secret} writable={data.writable} />
        ))}
      </div>
    </div>
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
  const [probe, setProbe] = useState<string | null>(null)

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
      setProbe(
        result.ok ? '连接成功' : result.httpStatus ? `连接失败 ${result.httpStatus}` : '连接失败',
      )
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setPending(null)
    }
  }

  const meta = [
    SOURCE_LABEL[secret.source],
    secret.updatedAt ? isoTime(secret.updatedAt) : '',
    secret.updatedBy ?? '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Card>
      <CardHeader className="space-y-1 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <CardTitle className="text-base">{secret.label}</CardTitle>
          <span
            className={secret.configured ? 'text-sm font-medium' : 'text-sm text-muted-foreground'}
          >
            {secret.configured ? '已配置' : '未配置'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{meta}</p>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <form
          className="space-y-3"
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
            placeholder="新密钥"
            aria-label={`${secret.label} 新密钥`}
            onChange={(event) => {
              setDraft(event.target.value)
              setProbe(null)
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!draft.trim() || pending !== null}
              onClick={() => void test()}
            >
              {pending === 'test' ? '测试中' : '测试连接'}
            </Button>
            <Button type="submit" disabled={!writable || !draft.trim() || pending !== null}>
              {pending === 'save' ? '保存中' : '保存'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={secret.source !== 'admin' || pending !== null}
              onClick={() => void clear()}
            >
              {pending === 'clear' ? '清除中' : '清除'}
            </Button>
          </div>
          {probe ? <p className="text-sm">{probe}</p> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </form>
      </CardContent>
    </Card>
  )
}
