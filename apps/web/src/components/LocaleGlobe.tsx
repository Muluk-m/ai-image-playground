import { useEffect, useRef, useState } from 'react'
import { type AppLocale, SUPPORTED_LOCALES, useTranslation } from '../i18n'
import { useLocalePicker } from '../i18n/useLocalePicker'
import { isInFloatingLayer } from '../lib/dropdown'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

/** 顶栏语言开关。界面语言只在这里改，头像菜单不再放第二份。 */
export default function LocaleGlobe() {
  const { t } = useTranslation('common')
  const { locale, change } = useLocalePicker()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (isInFloatingLayer(event.target)) return
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="rounded-full"
        aria-label={t('locale.label')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="language" />
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label={t('locale.label')}
          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-36 rounded-xl border border-border bg-card p-1 text-sm shadow-popover"
        >
          {SUPPORTED_LOCALES.map((code) => (
            <Button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={locale === code}
              variant={locale === code ? 'secondary' : 'ghost'}
              className="w-full justify-start"
              lang={code}
              onClick={() => {
                change(code as AppLocale)
                setOpen(false)
              }}
            >
              {t(`locale.${code}` as const)}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
