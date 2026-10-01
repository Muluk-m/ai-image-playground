import type { ProductionMediaReference } from '@image-playground/shared'
import { ImageOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

export default function ProductionReferencePreview({
  conversationId,
  reference,
  name,
}: {
  conversationId: string
  reference: ProductionMediaReference
  name: string
}) {
  const { t } = useTranslation('production')
  const holder = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (visible || !holder.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '100px' },
    )
    observer.observe(holder.current)
    return () => observer.disconnect()
  }, [visible])
  const [value, setValue] = useState<{ key: string; url: string | null }>()
  const id =
    reference.kind === 'media'
      ? reference.mediaId
      : reference.kind === 'asset'
        ? reference.imageId
        : reference.artifactId
  const key = `${conversationId}:${reference.kind}:${id}`
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let url: string | undefined
    void authenticatedBffFetch(
      `${bffBaseUrl()}/api/agent/conversations/${encodeURIComponent(conversationId)}/production/references/preview?kind=${reference.kind}&id=${encodeURIComponent(id)}`,
      { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('reference_unavailable')
        const blob = await response.blob()
        if (controller.signal.aborted) return
        url = URL.createObjectURL(blob)
        setValue({ key, url })
      })
      .catch(() => {
        if (!controller.signal.aborted) setValue({ key, url: null })
      })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [key, conversationId, reference.kind, id, visible])
  return (
    <span ref={holder} className="production-reference-image">
      {value?.key === key ? (
        value.url ? (
          <img src={value.url} alt={name} />
        ) : (
          <span className="production-reference-missing">
            <ImageOff size={22} />
            {t('asset.referenceMissing', { name })}
          </span>
        )
      ) : (
        <span className="production-reference-loading" aria-label={t('asset.loading')} />
      )}
    </span>
  )
}
