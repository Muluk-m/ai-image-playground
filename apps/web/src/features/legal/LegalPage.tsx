import { SUPPORT_CONTACT, SUPPORT_MAILTO, SUPPORT_X_URL } from '@image-playground/shared'
import { type ReactNode, useEffect, useState } from 'react'
import Dialog from '../../components/patterns/Dialog'
import { Button } from '../../components/ui/button'
import { i18next, setDocumentTitleOverride, useTranslation } from '../../i18n'
import { useLocalePicker } from '../../i18n/useLocalePicker'
import { isPrivacyPath } from '../../lib/appPaths'
import { navigate, usePathname } from '../../lib/pathname'
import { type LegalSectionId, PRIVACY_SECTIONS, TERMS_SECTIONS } from './sections'

/**
 * DRAFT legal copy for the owner to review before it is treated as binding.
 * The word "draft" stays in this comment and the pull request; it is not shown
 * in the page.
 */
export default function LegalPage() {
  const pathname = usePathname()
  const privacy = isPrivacyPath(pathname)
  const sections = privacy ? PRIVACY_SECTIONS : TERMS_SECTIONS
  const { t } = useTranslation('legal')
  const { t: tCommon } = useTranslation('common')
  const { locale, change } = useLocalePicker()
  const [contactOpen, setContactOpen] = useState(false)

  useEffect(() => {
    setDocumentTitleOverride(() =>
      privacy
        ? i18next.t('privacy.documentTitle', { ns: 'legal' })
        : i18next.t('terms.documentTitle', { ns: 'legal' }),
    )
    return () => setDocumentTitleOverride(null)
  }, [privacy])

  return (
    <main className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-4 px-5">
          <a
            href={locale === 'en' ? '/en/' : '/'}
            className="flex items-center gap-2 font-semibold"
          >
            <img src="/brand/muvloom-mark.svg" alt="" width={24} height={24} />
            {t('brand')}
          </a>
          <nav className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
            <a
              href="/terms"
              aria-current={privacy ? undefined : 'page'}
              onClick={(event) => {
                event.preventDefault()
                navigate('/terms')
              }}
              className={privacy ? 'hover:text-foreground' : 'text-foreground'}
            >
              {t('terms.title')}
            </a>
            <a
              href="/privacy"
              aria-current={privacy ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault()
                navigate('/privacy')
              }}
              className={privacy ? 'text-foreground' : 'hover:text-foreground'}
            >
              {t('privacy.title')}
            </a>
            <div role="group" aria-label={tCommon('locale.label')} className="flex gap-1">
              {(['zh-CN', 'en'] as const).map((code) => (
                <Button
                  key={code}
                  type="button"
                  size="xs"
                  variant={locale === code ? 'secondary' : 'ghost'}
                  aria-pressed={locale === code}
                  onClick={() => change(code)}
                >
                  {tCommon(code === 'zh-CN' ? 'locale.zh-CN' : 'locale.en')}
                </Button>
              ))}
            </div>
          </nav>
        </div>
      </header>
      <article className="mx-auto max-w-3xl px-5 py-12">
        <h1 className="font-display text-headline font-semibold tracking-tight">
          {privacy ? t('privacy.title') : t('terms.title')}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {privacy ? t('privacy.updated') : t('terms.updated')}
        </p>
        <p className="mt-6 text-sm leading-7 text-muted-foreground">
          {privacy ? t('privacy.intro') : t('terms.intro')}
        </p>
        <div className="mt-10 space-y-10">
          {sections.map((id) =>
            id === 'contact' ? (
              <ContactSection key={id} onOpen={() => setContactOpen(true)} />
            ) : (
              <section key={id} id={id}>
                <h2 className="text-xl font-semibold">{sectionCopy(id, 'title')}</h2>
                <p className="mt-3 whitespace-pre-line text-sm leading-7 text-foreground">
                  {linkifyContact(sectionCopy(id, 'body'))}
                </p>
              </section>
            ),
          )}
        </div>
      </article>
      {contactOpen ? <ContactDialog onClose={() => setContactOpen(false)} /> : null}
    </main>
  )
}

const textLinkClass =
  'underline underline-offset-2 hover:text-primary rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * 登录用户打开 `/#contact` 时，营销页在绘制前就被换成 `/image`（见 rootSessionSelection 与
 * SiteAuth），联系弹层不会出现。条款页就地打开同一套公开渠道：邮箱与 X，不含运营主体。
 */
function ContactSection({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation('legal')
  return (
    <section id="contact">
      <h2 className="text-xl font-semibold">{t('sections.contact.title')}</h2>
      <p className="mt-3 text-sm leading-7 text-foreground">
        {linkifyContact(
          t('sections.contact.before', {
            email: SUPPORT_CONTACT.email,
            x: SUPPORT_CONTACT.xHandle,
          }),
        )}
        <a href="/#contact" className={textLinkClass} onClick={openContactHere(onOpen)}>
          {t('sections.contact.action')}
        </a>
        {t('sections.contact.after')}
      </p>
      <p className="mt-3 whitespace-pre-line text-sm leading-7 text-foreground">
        {t('sections.contact.updates')}
      </p>
    </section>
  )
}

function ContactDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('legal')
  return (
    <Dialog title={t('sections.contact.dialogTitle')} onClose={onClose}>
      <div className="flex flex-col items-start gap-3 text-sm">
        <a href={SUPPORT_MAILTO} className={textLinkClass}>
          {SUPPORT_CONTACT.email}
        </a>
        <a href={SUPPORT_X_URL} target="_blank" rel="noopener noreferrer" className={textLinkClass}>
          @{SUPPORT_CONTACT.xHandle}
        </a>
      </div>
    </Dialog>
  )
}

function openContactHere(onOpen: () => void) {
  return (event: { preventDefault(): void }) => {
    event.preventDefault()
    onOpen()
  }
}

function linkifyContact(text: string): ReactNode[] {
  const email = SUPPORT_CONTACT.email
  const handle = `@${SUPPORT_CONTACT.xHandle}`
  const pattern = new RegExp(`(${escapeRegExp(email)}|${escapeRegExp(handle)})`, 'g')
  return text.split(pattern).map((part, index) => {
    if (part === email)
      return (
        <a key={`${part}-${index}`} href={SUPPORT_MAILTO} className={textLinkClass}>
          {email}
        </a>
      )
    if (part === handle)
      return (
        <a
          key={`${part}-${index}`}
          href={SUPPORT_X_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={textLinkClass}
        >
          {handle}
        </a>
      )
    return part
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sectionCopy(id: LegalSectionId, part: 'title' | 'body'): string {
  return i18next.t(`sections.${id}.${part}` as 'sections.accounts.title', {
    ns: 'legal',
    email: SUPPORT_CONTACT.email,
    x: SUPPORT_CONTACT.xHandle,
  })
}
