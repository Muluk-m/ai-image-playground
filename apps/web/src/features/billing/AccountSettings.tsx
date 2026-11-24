import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button, Dialog, Icon, Input } from '../../lib/privateHost'
import { AccountAvatar } from './AccountAvatar'
import { AvatarCropDialog, AvatarCropFrame } from './AvatarCropDialog'
import { avatarFileIssue } from './avatar-crop'
import { tBilling, useTranslation } from './i18n'
import {
  type AccountProfile,
  deleteAccount,
  describeSessions,
  fetchLoginMethods,
  fetchProfile,
  fetchSessions,
  googleLinkUrl,
  type LoginMethods,
  type LoginSession,
  type NicknameIssue,
  nicknameIssue,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  ProfileRequestError,
  revokeOtherSessions,
  unlinkGoogle,
  updatePassword,
  updateProfile,
  uploadAvatar,
} from './profile-client'
import { publishProfile } from './profile-store'

export type SettingsPreview = 'default' | 'crop' | 'error' | 'saving' | 'success'

const PREVIEW_AVATAR =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const FIXTURE_PROFILE: AccountProfile = {
  userId: 'u_8f73a2e9q',
  username: 'qingyou@studio.cn',
  nickname: '青柚工作室',
  bio: null,
  avatarUrl: null,
  avatarIsDefault: true,
}

const FIXTURE_METHODS: LoginMethods = {
  password: true,
  google: { linked: true, email: 'qingyou@gmail.com' },
}

const FIXTURE_SESSIONS: LoginSession[] = [
  { current: true, deviceLabel: 'Chrome · macOS', userAgent: null, ip: null },
  { current: false, deviceLabel: 'Safari · iOS', userAgent: null, ip: null },
  { current: false, deviceLabel: 'Chrome · Windows', userAgent: null, ip: null },
]

type Pending = 'nickname' | 'password' | 'avatar' | 'unlink' | 'revoke' | 'delete' | null

type EditorKind = 'nickname' | 'password'

function failureMessage(code: string): string {
  if (code === 'nickname_blocked' || code === 'nickname_reserved' || code === 'reserved') {
    return tBilling('settings.nicknameReserved')
  }
  if (code === 'nickname_invalid' || code === 'nickname_too_long') {
    return tBilling('settings.nicknameInvalid')
  }
  if (code === 'bio_invalid') return tBilling('settings.bioInvalid')
  if (code === 'avatar_type') return tBilling('settings.avatarType')
  if (code === 'avatar_too_large') return tBilling('settings.avatarSize')
  if (code === 'avatar_invalid') return tBilling('settings.avatarInvalid')
  if (code === 'invalid_credentials') return tBilling('settings.wrongPassword')
  if (code === 'current_password_required') return tBilling('settings.passwordRequired')
  if (code === 'account_delete_blocked') return tBilling('settings.deleteBlocked')
  if (code === 'invalid_password') {
    return tBilling('settings.passwordLength', {
      min: PASSWORD_MIN_LENGTH,
      max: PASSWORD_MAX_LENGTH,
    })
  }
  if (code === 'rate_limited') return tBilling('settings.rateLimited')
  if (code === 'last_login_method') return tBilling('settings.lastMethod')
  if (code === 'not_linked') return tBilling('settings.notLinkedError')
  if (code === 'identity_taken') return tBilling('settings.linkTaken')
  if (code === 'access_denied') return tBilling('settings.linkDenied')
  return tBilling('settings.saveFailed')
}

function nicknameMessage(issue: NicknameIssue): string {
  if (issue === 'empty') return tBilling('settings.nicknameEmpty')
  if (issue === 'blocked') return tBilling('settings.nicknameReserved')
  return tBilling('settings.nicknameInvalid')
}

function requestCode(error: unknown): string {
  return error instanceof ProfileRequestError ? error.code : 'save_failed'
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 px-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="divide-y divide-border rounded-2xl border border-border bg-muted/40 px-4">
        {children}
      </div>
    </section>
  )
}

function RowMark({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return (
    <span
      className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${
        danger ? 'bg-destructive/10 text-destructive' : 'bg-background text-muted-foreground'
      }`}
    >
      {children}
    </span>
  )
}

function deviceLine(sessions: LoginSession[] | null, failed: boolean): string {
  if (failed) return tBilling('settings.devicesFailed')
  if (!sessions) return tBilling('settings.devicesLoading')
  const described = describeSessions(sessions)
  if (!described) return tBilling('settings.devicesFailed')
  const current = tBilling('settings.deviceCurrentLabel', {
    label: described.label || tBilling('settings.deviceThis'),
  })
  if (described.others <= 0) return current
  return tBilling('settings.deviceJoin', {
    current,
    others: tBilling('settings.deviceOthers', { count: described.others, n: described.others }),
  })
}

export function AccountSettings({
  username,
  preview,
  onAccountDeleted,
}: {
  username: string | null
  preview?: SettingsPreview
  onAccountDeleted: () => void
}) {
  useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const [profile, setProfile] = useState<AccountProfile | null>(() => {
    if (!preview) return null
    return {
      ...FIXTURE_PROFILE,
      avatarUrl: preview === 'success' ? PREVIEW_AVATAR : null,
      avatarIsDefault: preview !== 'success',
    }
  })
  const [methods, setMethods] = useState<LoginMethods | null>(preview ? FIXTURE_METHODS : null)
  const [sessions, setSessions] = useState<LoginSession[] | null>(preview ? FIXTURE_SESSIONS : null)
  const [sessionsError, setSessionsError] = useState(false)
  const [loading, setLoading] = useState(!preview)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [editor, setEditor] = useState<EditorKind | null>(
    preview === 'error' || preview === 'saving' ? 'nickname' : null,
  )
  const [nicknameDraft, setNicknameDraft] = useState(preview === 'error' ? '官方' : '青柚工作室')
  const [nicknameServerError, setNicknameServerError] = useState<string | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [cropUrl, setCropUrl] = useState<string | null>(preview === 'crop' ? PREVIEW_AVATAR : null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(
    preview === 'success' ? tBilling('settings.toastAvatar') : null,
  )
  const [alert, setAlert] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(preview === 'saving' ? 'nickname' : null)
  const [avatarSaved, setAvatarSaved] = useState(preview === 'success')
  const [avatarIssue, setAvatarIssue] = useState<string | null>(null)

  useEffect(() => {
    if (preview) return
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    void (async () => {
      try {
        const [nextProfile, nextMethods] = await Promise.all([fetchProfile(), fetchLoginMethods()])
        if (cancelled) return
        setProfile(nextProfile)
        publishProfile(nextProfile)
        setMethods(nextMethods)
      } catch {
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
      try {
        const nextSessions = await fetchSessions()
        if (!cancelled) {
          setSessions(nextSessions)
          setSessionsError(false)
        }
      } catch {
        if (!cancelled) setSessionsError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [preview, reloadKey])

  useEffect(() => {
    if (!notice || preview) return
    const timer = window.setTimeout(() => setNotice(null), 3200)
    return () => window.clearTimeout(timer)
  }, [notice, preview])

  useEffect(() => {
    if (preview || typeof window === 'undefined') return
    const url = new URL(window.location.href)
    const linked = url.searchParams.get('auth_link')
    const failed = url.searchParams.get('auth_link_error')
    if (!linked && !failed) return
    if (failed) setAlert(failureMessage(failed))
    else setNotice(tBilling('settings.toastLinked', { provider: 'Google' }))
    url.searchParams.delete('auth_link')
    url.searchParams.delete('auth_link_error')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    void fetchLoginMethods()
      .then((next) => setMethods(next))
      .catch(() => undefined)
  }, [preview])

  const shownNickname = profile?.nickname?.trim() || username || tBilling('account.fallbackName')
  const emailSource = profile?.username || username || ''
  const email = emailSource.includes('@') ? emailSource : null
  const localNicknameIssue = editor === 'nickname' ? nicknameIssue(nicknameDraft) : null
  const shownNicknameError =
    nicknameServerError ?? (localNicknameIssue ? nicknameMessage(localNicknameIssue) : null)
  const others = sessions ? (describeSessions(sessions)?.others ?? 0) : 0
  const phase = cropUrl
    ? 'crop'
    : pending === 'nickname' || pending === 'avatar'
      ? 'saving'
      : shownNicknameError
        ? 'error'
        : notice
          ? 'success'
          : 'default'

  function closeCrop(): void {
    if (cropUrl?.startsWith('blob:')) URL.revokeObjectURL(cropUrl)
    setCropUrl(null)
  }

  function applyProfile(next: AccountProfile): void {
    setProfile(next)
    publishProfile(next)
  }

  function chooseFile(file: File | undefined): void {
    if (!file) return
    const issue = avatarFileIssue(file)
    if (issue === 'type') {
      setAvatarIssue(tBilling('settings.avatarType'))
      return
    }
    if (issue === 'size') {
      setAvatarIssue(tBilling('settings.avatarSize'))
      return
    }
    setAvatarIssue(null)
    if (cropUrl?.startsWith('blob:')) URL.revokeObjectURL(cropUrl)
    setCropUrl(URL.createObjectURL(file))
  }

  async function saveNickname(): Promise<void> {
    if (!profile || pending) return
    const issue = nicknameIssue(nicknameDraft)
    if (issue) {
      setNicknameServerError(null)
      return
    }
    const next = nicknameDraft.trim()
    if (next === (profile.nickname ?? '').trim()) {
      setEditor(null)
      return
    }
    setPending('nickname')
    setNicknameServerError(null)
    setAlert(null)
    try {
      const updated = await updateProfile({ nickname: next })
      applyProfile(updated.userId ? updated : { ...profile, ...updated, nickname: next })
      setEditor(null)
      setNotice(tBilling('settings.toastNickname'))
    } catch (error) {
      const code = requestCode(error)
      if (
        code === 'nickname_invalid' ||
        code === 'nickname_blocked' ||
        code === 'nickname_reserved'
      ) {
        setNicknameServerError(failureMessage(code))
      } else setAlert(failureMessage(code))
    } finally {
      setPending(null)
    }
  }

  async function savePassword(): Promise<void> {
    if (!methods || pending) return
    if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > PASSWORD_MAX_LENGTH) {
      setPasswordError(
        tBilling('settings.passwordLength', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }),
      )
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(tBilling('settings.passwordMismatch'))
      return
    }
    setPending('password')
    setPasswordError(null)
    setAlert(null)
    try {
      await updatePassword({
        currentPassword: methods.password ? currentPassword : undefined,
        newPassword,
      })
      setMethods(await fetchLoginMethods())
      setEditor(null)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setNotice(tBilling(methods.password ? 'settings.toastPassword' : 'settings.toastPasswordSet'))
    } catch (error) {
      setPasswordError(failureMessage(requestCode(error)))
    } finally {
      setPending(null)
    }
  }

  async function onUnlink(): Promise<void> {
    if (pending) return
    setConfirmUnlink(false)
    setPending('unlink')
    setAlert(null)
    try {
      await unlinkGoogle()
      setMethods(await fetchLoginMethods())
      setNotice(tBilling('settings.toastUnlinked'))
    } catch (error) {
      setAlert(failureMessage(requestCode(error)))
    } finally {
      setPending(null)
    }
  }

  async function onRevoke(): Promise<void> {
    if (pending || others <= 0) return
    setPending('revoke')
    setAlert(null)
    try {
      await revokeOtherSessions()
      setSessions(await fetchSessions())
      setNotice(tBilling('settings.toastRevoked'))
    } catch (error) {
      setAlert(failureMessage(requestCode(error)))
    } finally {
      setPending(null)
    }
  }

  function openDelete(): void {
    setDeletePassword('')
    setDeleteError(null)
    setDeleteOpen(true)
  }

  async function onDelete(): Promise<void> {
    if (pending) return
    if (methods?.password && deletePassword.length === 0) {
      setDeleteError(tBilling('settings.passwordRequired'))
      return
    }
    setPending('delete')
    setDeleteError(null)
    try {
      await deleteAccount(methods?.password ? deletePassword : undefined)
      onAccountDeleted()
    } catch (error) {
      setDeleteError(failureMessage(requestCode(error)))
      setPending(null)
    }
  }

  async function onCropped(blob: Blob): Promise<void> {
    if (!profile || pending) return
    setPending('avatar')
    setAlert(null)
    try {
      const updated = await uploadAvatar(blob)
      applyProfile(updated.userId ? updated : { ...updated, avatarUrl: profile.avatarUrl })
      setAvatarSaved(true)
      setNotice(tBilling('settings.toastAvatar'))
      closeCrop()
    } catch (error) {
      setAlert(failureMessage(requestCode(error)))
    } finally {
      setPending(null)
    }
  }

  const cropSaving = pending === 'avatar'
  const cropProps = cropUrl
    ? {
        imageUrl: cropUrl,
        saving: cropSaving,
        onClose: closeCrop,
        onReselect: () => fileRef.current?.click(),
        onConfirm: (blob: Blob) => void onCropped(blob),
        onError: () => setAlert(tBilling('settings.avatarExportFailed')),
      }
    : null

  return (
    <div data-settings-phase={phase} className="space-y-6" aria-busy={pending !== null}>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        aria-label={tBilling('settings.changeAvatar')}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          chooseFile(file)
        }}
      />
      {notice ? (
        <div
          role="status"
          className="flex w-fit max-w-full items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-popover"
        >
          <span className="grid h-5 w-5 place-items-center rounded-full bg-success/10 text-success">
            <Icon name="check" size="xs" />
          </span>
          {notice}
        </div>
      ) : null}
      {alert ? (
        <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {alert}
        </p>
      ) : null}
      {loading && !profile ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {tBilling('account.loading')}
        </p>
      ) : null}
      {loadError && !profile ? (
        <div className="rounded-2xl border border-destructive/60 bg-destructive/10 p-4 text-sm text-destructive">
          <p>{tBilling('settings.loadFailed')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            {tBilling('settings.retry')}
          </Button>
        </div>
      ) : null}

      {profile && methods ? (
        <>
          <Section title={tBilling('settings.profile')}>
            <div className="flex items-center gap-3 py-4">
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full bg-primary">
                <AccountAvatar src={profile.avatarUrl} />
              </div>
              <div className="min-w-0 flex-1 self-center">
                {profile.avatarUrl ? (
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{tBilling('settings.customAvatar')}</span>
                    {avatarSaved ? (
                      <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-label-sm text-success">
                        {tBilling('settings.saved')}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">{tBilling('settings.avatarHint')}</p>
                {avatarIssue ? (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {avatarIssue}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={pending !== null}
                onClick={() => fileRef.current?.click()}
              >
                {tBilling('settings.changeAvatar')}
              </Button>
            </div>

            <div className="flex items-start gap-3 py-4">
              <RowMark>
                <Icon name="user" />
              </RowMark>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{tBilling('settings.nickname')}</div>
                {editor === 'nickname' ? (
                  <div className="mt-2">
                    <Input
                      aria-label={tBilling('settings.nickname')}
                      aria-invalid={shownNicknameError ? true : undefined}
                      value={nicknameDraft}
                      maxLength={40}
                      disabled={pending === 'nickname'}
                      className={shownNicknameError ? 'border-destructive' : undefined}
                      onChange={(event) => {
                        setNicknameDraft(event.currentTarget.value)
                        setNicknameServerError(null)
                      }}
                    />
                    {shownNicknameError ? (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {shownNicknameError}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-1 truncate text-xs text-muted-foreground">{shownNickname}</p>
                )}
              </div>
              {editor === 'nickname' ? (
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending === 'nickname'}
                    onClick={() => {
                      setEditor(null)
                      setNicknameServerError(null)
                    }}
                  >
                    {tBilling('settings.cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending === 'nickname' || Boolean(localNicknameIssue)}
                    aria-busy={pending === 'nickname'}
                    onClick={() => void saveNickname()}
                  >
                    {pending === 'nickname' ? (
                      <Icon name="loading" size="xs" className="animate-spin" />
                    ) : null}
                    {tBilling(pending === 'nickname' ? 'settings.saving' : 'settings.save')}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  disabled={pending !== null}
                  onClick={() => {
                    setNicknameDraft(profile.nickname?.trim() || username || '')
                    setNicknameServerError(null)
                    setEditor('nickname')
                  }}
                >
                  <Icon name="edit" />
                  {tBilling('settings.edit')}
                </Button>
              )}
            </div>
          </Section>

          <Section title={tBilling('settings.login')}>
            <div className="flex items-start gap-3 py-4">
              <RowMark>
                <span className="text-sm font-semibold">@</span>
              </RowMark>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{tBilling('settings.email')}</span>
                  {email ? (
                    <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-label-sm text-success">
                      {tBilling('settings.verified')}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {email ?? tBilling('settings.notBound')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 py-4">
              <RowMark>
                <span className="text-sm font-semibold">G</span>
              </RowMark>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{tBilling('settings.google')}</div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {methods.google.linked
                    ? methods.google.email
                      ? tBilling('settings.linkedEmail', { email: methods.google.email })
                      : tBilling('settings.linked')
                    : tBilling('settings.notLinked')}
                </p>
              </div>
              {methods.google.linked ? (
                confirmUnlink ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending !== null}
                      onClick={() => setConfirmUnlink(false)}
                    >
                      {tBilling('settings.cancel')}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={pending !== null}
                      onClick={() => void onUnlink()}
                    >
                      {tBilling('settings.confirmUnlink')}
                    </Button>
                  </div>
                ) : (
                  (() => {
                    const onlyLoginMethod = !methods.password && (methods.linkedCount ?? 1) <= 1
                    return (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={pending !== null || onlyLoginMethod}
                        title={
                          onlyLoginMethod ? tBilling('settings.unlinkLastMethodHint') : undefined
                        }
                        onClick={() => setConfirmUnlink(true)}
                      >
                        {tBilling('settings.unlink')}
                      </Button>
                    )
                  })()
                )
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={pending !== null}
                  onClick={() => {
                    window.location.assign(googleLinkUrl())
                  }}
                >
                  {tBilling('settings.link')}
                </Button>
              )}
            </div>

            <div className="py-4">
              <div className="flex items-center gap-3">
                <RowMark>
                  <Icon name="lock" />
                </RowMark>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{tBilling('settings.password')}</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tBilling(methods.password ? 'settings.passwordSet' : 'settings.passwordUnset')}
                  </p>
                </div>
                {editor === 'password' ? null : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={pending !== null}
                    onClick={() => {
                      setPasswordError(null)
                      setCurrentPassword('')
                      setNewPassword('')
                      setConfirmPassword('')
                      setEditor('password')
                    }}
                  >
                    {tBilling(methods.password ? 'settings.modify' : 'settings.setPassword')}
                  </Button>
                )}
              </div>
              {editor === 'password' ? (
                <form
                  className="mt-3 space-y-3 pl-12"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void savePassword()
                  }}
                >
                  {methods.password ? (
                    <Input
                      type="password"
                      autoComplete="current-password"
                      aria-label={tBilling('settings.currentPassword')}
                      placeholder={tBilling('settings.currentPassword')}
                      value={currentPassword}
                      maxLength={PASSWORD_MAX_LENGTH}
                      disabled={pending === 'password'}
                      onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                    />
                  ) : null}
                  <Input
                    type="password"
                    autoComplete="new-password"
                    aria-label={tBilling('settings.newPassword')}
                    placeholder={tBilling('settings.newPassword')}
                    value={newPassword}
                    maxLength={PASSWORD_MAX_LENGTH}
                    disabled={pending === 'password'}
                    onChange={(event) => setNewPassword(event.currentTarget.value)}
                  />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    aria-label={tBilling('settings.confirmPassword')}
                    placeholder={tBilling('settings.confirmPassword')}
                    value={confirmPassword}
                    maxLength={PASSWORD_MAX_LENGTH}
                    disabled={pending === 'password'}
                    onChange={(event) => setConfirmPassword(event.currentTarget.value)}
                  />
                  {passwordError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {passwordError}
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending === 'password'}
                      onClick={() => setEditor(null)}
                    >
                      {tBilling('settings.cancel')}
                    </Button>
                    <Button type="submit" size="sm" disabled={pending === 'password'}>
                      {tBilling(pending === 'password' ? 'settings.saving' : 'settings.save')}
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
          </Section>

          <Section title={tBilling('settings.security')}>
            <div className="flex items-center gap-3 py-4">
              <RowMark>
                <Icon name="resolution" />
              </RowMark>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{tBilling('settings.devices')}</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {deviceLine(sessions, sessionsError)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={pending !== null || sessionsError || others <= 0}
                onClick={() => void onRevoke()}
              >
                {tBilling(pending === 'revoke' ? 'settings.revoking' : 'settings.revokeOthers')}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start gap-3 whitespace-normal rounded-none px-0 py-4 text-left"
              onClick={openDelete}
            >
              <RowMark danger>
                <Icon name="delete" />
              </RowMark>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-destructive">
                  {tBilling('settings.deleteAccount')}
                </span>
                <span className="mt-1 block text-xs text-destructive">
                  {tBilling('settings.deleteHint')}
                </span>
              </span>
              <Icon name="chevronRight" className="text-destructive" />
            </Button>
          </Section>
        </>
      ) : null}

      {cropProps && preview ? <AvatarCropFrame {...cropProps} sheet={false} /> : null}
      {cropProps && !preview ? <AvatarCropDialog {...cropProps} /> : null}

      {deleteOpen ? (
        <Dialog
          tier="raised"
          title={tBilling('settings.deleteTitle')}
          onClose={() => {
            if (pending !== 'delete') setDeleteOpen(false)
          }}
          footer={
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending === 'delete'}
                onClick={() => setDeleteOpen(false)}
              >
                {tBilling('settings.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending === 'delete'}
                onClick={() => void onDelete()}
              >
                {tBilling(pending === 'delete' ? 'settings.deleting' : 'settings.deleteConfirm')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">{tBilling('settings.deleteBody')}</p>
          {methods?.password ? (
            <Input
              type="password"
              autoComplete="current-password"
              aria-label={tBilling('settings.currentPassword')}
              placeholder={tBilling('settings.currentPassword')}
              value={deletePassword}
              maxLength={PASSWORD_MAX_LENGTH}
              disabled={pending === 'delete'}
              className={`mt-3 ${deleteError ? 'border-destructive' : ''}`}
              onChange={(event) => {
                setDeletePassword(event.currentTarget.value)
                setDeleteError(null)
              }}
            />
          ) : null}
          {deleteError ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {deleteError}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </div>
  )
}
