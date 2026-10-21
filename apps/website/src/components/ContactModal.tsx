import { useState } from 'react'
import Overlay from '../../../web/src/components/patterns/Overlay'
import { Icon } from '../../../web/src/components/ui/icon'
import type { Locale } from '../catalog'
import { CONTACT_EMAIL, type MarketingCopy, marketingCopy, X_URL } from '../marketing'

/**
 * 联系方式弹层。
 * 微信入口预留：传入 `wechat.qrSrc` 后才渲染二维码选项。当前不传，不渲染。
 */
export interface ContactWechat {
  qrSrc: string
  title?: string
  detail?: string
}

export function ContactModal({
  open,
  locale,
  onClose,
  wechat = null,
}: {
  open: boolean
  locale: Locale
  onClose: () => void
  wechat?: ContactWechat | null
}) {
  if (!open) return null
  const text = marketingCopy[locale].contact
  return (
    <Overlay onClose={onClose} role="none" backdrop="none" label={text.title}>
      <div className="cback" aria-hidden="true" />
      <ContactPanel locale={locale} text={text} onClose={onClose} wechat={wechat} />
    </Overlay>
  )
}

export function ContactPanel({
  locale,
  text = marketingCopy[locale].contact,
  onClose,
  wechat = null,
}: {
  locale: Locale
  text?: MarketingCopy['contact']
  onClose?: () => void
  wechat?: ContactWechat | null
}) {
  const [copyLabel, setCopyLabel] = useState(text.copy)
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(CONTACT_EMAIL)
      setCopyLabel(text.copied)
    } catch {
      setCopyLabel(text.copyFailed)
    }
    window.setTimeout(() => setCopyLabel(text.copy), 1600)
  }
  return (
    <div className="cbox" role="dialog" aria-modal="true" aria-labelledby="contact-title">
      <button type="button" className="cx" onClick={onClose} aria-label={text.close}>
        <Icon name="close" />
      </button>
      <h3 id="contact-title">{text.title}</h3>
      <p>{text.body}</p>
      <div className="copt">
        <span className="ci" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </span>
        <div className="ct">
          <b>{text.xTitle}</b>
          <span>{text.xDetail}</span>
        </div>
        <a className="cbtn pri" href={X_URL} target="_blank" rel="noopener noreferrer" autoFocus>
          {text.xAction}
        </a>
      </div>
      <div className="copt">
        <span className="ci" aria-hidden="true">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <rect x="3" y="5" width="18" height="14" rx="2.5" />
            <path d="m4 7 8 6 8-6" />
          </svg>
        </span>
        <div className="ct">
          <b>{text.mailTitle}</b>
          <span>{text.mail}</span>
        </div>
        <button type="button" className="cbtn" onClick={() => void copyAddress()}>
          {copyLabel}
        </button>
        <a className="cbtn pri" href={`mailto:${CONTACT_EMAIL}`}>
          {text.send}
        </a>
      </div>
      {wechat ? (
        <div className="copt" data-contact-channel="wechat">
          <img className="ci" src={wechat.qrSrc} width={38} height={38} alt="" />
          <div className="ct">
            <b>{wechat.title ?? '微信'}</b>
            <span>{wechat.detail ?? ''}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
