import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { useTranslation } from '../../i18n'
import {
  AuthRequestError,
  type CliConnectionSummary,
  fetchCliConnections,
  revokeCliConnection,
} from '../../lib/authClient'
import {
  connectionCapabilities,
  formatRecentActivity,
  formatShortDate,
  isExpiringSoon,
  isRecentlyActive,
  parseCliUserAgent,
  shortConnectionId,
} from './cliConnectionMeta'

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

  const now = Date.now()

  return (
    <section
      className={
        standalone
          ? 'rounded-2xl border border-border bg-card p-6'
          : 'mt-6 border-t border-border pt-6'
      }
      aria-labelledby="cli-connections-title"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h4
            id="cli-connections-title"
            className={
              standalone
                ? 'text-title-sm font-semibold text-foreground'
                : 'text-body-sm font-medium text-foreground'
            }
          >
            {t('cliConnections.title')}
          </h4>
          {state === 'ready' && connections.length > 0 ? (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-secondary px-1.5 font-mono text-label-sm tabular-nums text-muted-foreground">
              {connections.length}
            </span>
          ) : null}
        </div>
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
        <div
          className="rounded-xl border border-border/70 bg-background/50 px-4 py-6 text-center"
          role="status"
        >
          <p className="text-body-sm text-muted-foreground">{t('cliConnections.loading')}</p>
        </div>
      ) : state === 'failed' ? (
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3"
          role="alert"
        >
          <p className="text-body-sm text-destructive">{t('cliConnections.loadFailed')}</p>
        </div>
      ) : connections.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 bg-background/40 px-4 py-8 text-center">
          <Icon name="terminal" size="md" className="text-muted-foreground/60" />
          <p className="text-body-sm text-muted-foreground">{t('cliConnections.empty')}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-background/60">
          {connections.map((connection) => {
            const parsed = parseCliUserAgent(connection.user_agent)
            const active = isRecentlyActive(connection.last_used_at, now)
            const expiringSoon = isExpiringSoon(connection.expires_at, now)
            const capabilities = connectionCapabilities(connection.scopes)

            const metadataItems: Array<{ key: string; node: ReactNode }> = [
              {
                key: 'lastUsed',
                node:
                  connection.last_used_at === null ? (
                    <span>{t('cliConnections.neverUsed')}</span>
                  ) : (
                    <span
                      title={new Date(connection.last_used_at).toLocaleString(i18n.language)}
                      className={active ? 'text-foreground/85' : undefined}
                    >
                      {t('cliConnections.lastUsedAt', {
                        date: formatRecentActivity(connection.last_used_at, now, i18n.language),
                      })}
                    </span>
                  ),
              },
            ]

            if (connection.job_count !== undefined) {
              metadataItems.push({
                key: 'jobs',
                node: (
                  <span
                    className={
                      connection.job_count > 0 ? 'font-medium text-foreground/85' : undefined
                    }
                  >
                    {t('cliConnections.jobCount', { count: connection.job_count })}
                  </span>
                ),
              })
            }

            metadataItems.push({
              key: 'connected',
              node: (
                <span title={new Date(connection.created_at).toLocaleString(i18n.language)}>
                  {t('cliConnections.connectedAt', {
                    date: formatShortDate(connection.created_at, i18n.language),
                  })}
                </span>
              ),
            })

            if (connection.expires_at !== undefined) {
              metadataItems.push({
                key: 'expires',
                node: (
                  <span
                    title={new Date(connection.expires_at).toLocaleString(i18n.language)}
                    className={expiringSoon ? 'text-warning' : undefined}
                  >
                    {t('cliConnections.expiresAt', {
                      date: formatShortDate(connection.expires_at, i18n.language),
                    })}
                  </span>
                ),
              })
            }

            return (
              <li
                key={connection.id}
                className={`transition-colors hover:bg-secondary/30 ${
                  standalone ? 'px-4 py-3.5' : 'px-3 py-3'
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    {standalone ? (
                      <div className="relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-secondary/60 text-foreground/80">
                        <Icon name="terminal" size="sm" />
                        <span
                          aria-hidden="true"
                          className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background ${
                            active ? 'bg-success' : 'bg-muted-foreground/45'
                          }`}
                        />
                      </div>
                    ) : null}

                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {!standalone ? (
                          <span
                            aria-hidden="true"
                            className={`size-2 shrink-0 rounded-full ${
                              active ? 'bg-success' : 'bg-muted-foreground/45'
                            }`}
                          />
                        ) : null}
                        <span className="min-w-0 break-words text-body-sm font-semibold text-foreground">
                          {connection.client_name}
                        </span>
                        {parsed.version ? (
                          <span className="rounded-md bg-primary/15 px-1.5 py-0.5 font-mono text-label-sm leading-none text-primary">
                            {parsed.version}
                          </span>
                        ) : null}
                        {parsed.platform ? (
                          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-label-sm leading-none text-foreground/85">
                            {parsed.platform}
                          </span>
                        ) : null}
                        <span
                          className="font-mono text-label-sm text-muted-foreground/80"
                          title={connection.id}
                        >
                          {shortConnectionId(connection.id)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
                        {metadataItems.map((item, index) => (
                          <span key={item.key} className="inline-flex items-center gap-2">
                            {index > 0 ? (
                              <span aria-hidden="true" className="text-border">
                                ·
                              </span>
                            ) : null}
                            {item.node}
                          </span>
                        ))}
                      </div>

                      {standalone && capabilities.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          {capabilities.map((capability) => (
                            <span
                              key={capability}
                              className="rounded-md border border-border/70 bg-card/70 px-1.5 py-0.5 text-label-sm leading-none text-muted-foreground"
                            >
                              {t(`cliDevice.capabilities.${capability}`)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0 self-start border-border/80 bg-transparent text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive sm:self-center"
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
              </li>
            )
          })}
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
