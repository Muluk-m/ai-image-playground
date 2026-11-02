import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { useTranslation } from '../../i18n'
import {
  AuthRequestError,
  type CliConnectionSummary,
  fetchCliConnections,
  revokeCliConnection,
} from '../../lib/authClient'

/** Account-only CLI sessions; the server decides whether this deployment offers CLI access. */
export default function CliConnectionsSection() {
  const { t, i18n } = useTranslation('auth')
  const [connections, setConnections] = useState<CliConnectionSummary[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'unavailable'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [notice, setNotice] = useState<'revoked' | 'revokeFailed' | null>(null)
  const pending = useRef(false)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    setState('loading')
    setNotice(null)
    void fetchCliConnections(controller.signal).then(
      (loaded) => {
        if (controller.signal.aborted) return
        setConnections(loaded)
        setState('ready')
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState(
          error instanceof AuthRequestError && error.code === 'capability_unavailable'
            ? 'unavailable'
            : 'failed',
        )
      },
    )
    return () => controller.abort()
  }, [attempt])

  async function revoke(id: string) {
    const controller = request.current
    if (pending.current || state !== 'ready' || !controller || controller.signal.aborted) return
    pending.current = true
    setRevoking(id)
    setNotice(null)
    try {
      await revokeCliConnection(id, controller.signal)
      if (controller.signal.aborted) return
      setConnections((current) => current.filter((connection) => connection.id !== id))
      setNotice('revoked')
    } catch {
      if (!controller.signal.aborted) setNotice('revokeFailed')
    } finally {
      pending.current = false
      if (!controller.signal.aborted) setRevoking(null)
    }
  }

  if (state === 'unavailable') return null

  return (
    <section className="mt-6 border-t border-border pt-6" aria-labelledby="cli-connections-title">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h4 id="cli-connections-title" className="text-body-sm font-medium text-foreground">
          {t('cliConnections.title')}
        </h4>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('cliConnections.refresh')}
          disabled={state === 'loading' || revoking !== null}
          onClick={() => setAttempt((current) => current + 1)}
        >
          <Icon name="refresh" />
        </Button>
      </div>
      {state === 'loading' ? (
        <p className="text-body-sm text-muted-foreground" role="status">
          {t('cliConnections.loading')}
        </p>
      ) : state === 'failed' ? (
        <p className="text-body-sm text-destructive" role="alert">
          {t('cliConnections.loadFailed')}
        </p>
      ) : connections.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t('cliConnections.empty')}</p>
      ) : (
        <ul className="space-y-3">
          {connections.map((connection) => (
            <li key={connection.id} className="rounded-xl border border-border px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words text-body-sm font-medium">
                  {connection.client_name}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive"
                  disabled={revoking !== null}
                  onClick={() => void revoke(connection.id)}
                >
                  {t(revoking === connection.id ? 'cliConnections.revoking' : 'cliConnections.revoke')}
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('cliConnections.connectedAt', {
                  date: new Date(connection.created_at).toLocaleString(i18n.language),
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {connection.last_used_at === null
                  ? t('cliConnections.neverUsed')
                  : t('cliConnections.lastUsedAt', {
                      date: new Date(connection.last_used_at).toLocaleString(i18n.language),
                    })}
              </p>
            </li>
          ))}
        </ul>
      )}
      {notice ? (
        <p
          className={`mt-3 text-body-sm ${notice === 'revokeFailed' ? 'text-destructive' : 'text-muted-foreground'}`}
          role={notice === 'revokeFailed' ? 'alert' : 'status'}
        >
          {t(notice === 'revokeFailed' ? 'cliConnections.revokeFailed' : 'cliConnections.revoked')}
        </p>
      ) : null}
    </section>
  )
}
