import { useEffect } from 'react'
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
          {sections.map((id) => (
            <section key={id} id={id}>
              <h2 className="text-xl font-semibold">{sectionCopy(id, 'title')}</h2>
              <p className="mt-3 whitespace-pre-line text-sm leading-7 text-foreground">
                {sectionCopy(id, 'body')}
              </p>
            </section>
          ))}
        </div>
      </article>
    </main>
  )
}

function sectionCopy(id: LegalSectionId, part: 'title' | 'body'): string {
  return i18next.t(`sections.${id}.${part}` as 'sections.accounts.title', { ns: 'legal' })
}
