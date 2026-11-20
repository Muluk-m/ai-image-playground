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

const POLL_INTERVAL_MS = 4000

/** Account-only CLI sessions; the server decides whether this deployment offers CLI access. */
export default function CliConnectionsSection({
  standalone = false,
  watchUntil,
  onUnavailable,
}: {
  standalone?: boolean
  watchUntil?: number
  onUnavailable?: () => void
}) {
  const { t, i18n } = useTranslation('auth')
  const [connections, setConnections] = useState<CliConnectionSummary[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'unavailable'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [notice, setNotice] = useState<'revoked' | 'revokeFailed' | null>(null)
  const revocation = useRef<AbortController | null>(null)
  const readRevision = useRef(0)

  useEffect(() => () => revocation.current?.abort(), [])

  useEffect(() => {
    const controller = new AbortController()
    const remaining = watchUntil === undefined ? 0 : watchUntil - performance.now()
    const watching = remaining > 0
    let timer: number | undefined
    let inFlight = false

    function schedule() {
      if (!watching || controller.signal.aborted || document.visibilityState === 'hidden') return
      timer = window.setTimeout(() => void load(), POLL_INTERVAL_MS)
    }

    async function load() {
      if (controller.signal.aborted || inFlight) return
      if (revocation.current) {
        schedule()
        return
      }
      inFlight = true
      const revision = readRevision.current
      try {
        const loaded = await fetchCliConnections(controller.signal)
        if (controller.signal.aborted || revision !== readRevision.current) return
        setConnections(loaded)
        setState('ready')
      } catch (error) {
        if (controller.signal.aborted || revision !== readRevision.current) return
        if (error instanceof AuthRequestError && error.code === 'capability_unavailable') {
          setState('unavailable')
          controller.abort()
          onUnavailable?.()
        } else if (
          error instanceof AuthRequestError &&
          (error.status === 401 || error.status === 403)
        ) {
          setState('failed')
          controller.abort()
        } else {
          setState((current) => (current === 'ready' && watching ? current : 'failed'))
        }
      } finally {
        inFlight = false
        schedule()
      }
    }

    function onVisibility() {
      window.clearTimeout(timer)
      if (document.visibilityState === 'visible') void load()
    }

    const expiry = watching
      ? window.setTimeout(() => {
          controller.abort()
          window.clearTimeout(timer)
          setState((current) => (current === 'loading' ? 'failed' : current))
        }, remaining)
      : undefined

    if (watching) document.addEventListener('visibilitychange', onVisibility)
    void load()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      window.clearTimeout(expiry)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [attempt, onUnavailable, watchUntil])

  async function revoke(id: string) {
    if (revocation.current || state !== 'ready') return
    const controller = new AbortController()
    revocation.current = controller
    readRevision.current++
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
      revocation.current = null
      if (!controller.signal.aborted) setRevoking(null)
    }
  }

  if (state === 'unavailable') return null

  return (
    <section
      className={
        standalone
          ? 'rounded-2xl border border-border bg-card p-6'
          : 'mt-6 border-t border-border pt-6'
      }
      aria-labelledby="cli-connections-title"
    >
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
          onClick={() => {
            setState('loading')
            setNotice(null)
            setAttempt((current) => current + 1)
          }}
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
                  {t(
                    revoking === connection.id
                      ? 'cliConnections.revoking'
                      : 'cliConnections.revoke',
                  )}
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
