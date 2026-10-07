import { LoaderCircle, MessageCircle } from 'lucide-react'
import { useCallback, useState } from 'react'
import MediaImage from '../../../components/MediaImage'
import { useTranslation } from '../../../i18n'

export default function ProjectCover({
  source,
  chat,
  pending = false,
}: {
  source?: string
  chat: boolean
  pending?: boolean
}) {
  const { t } = useTranslation('canvas')
  const [settled, setSettled] = useState<{ source: string; failed: boolean }>()
  const fail = useCallback(() => {
    if (source) setSettled({ source, failed: true })
  }, [source])
  const loading = source ? settled?.source !== source : pending
  const failed = source && settled?.source === source && settled.failed
  return (
    <>
      {source && !failed && (
        <>
          <MediaImage
            src={source}
            alt=""
            loading="lazy"
            aria-hidden="true"
            className="absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-2xl saturate-150"
          />
          <MediaImage
            src={source}
            alt=""
            loading="lazy"
            onLoad={() => setSettled({ source, failed: false })}
            onError={() => setSettled({ source, failed: true })}
            onResolveError={fail}
            className={`relative h-full w-full object-contain ${loading ? 'opacity-0' : ''}`}
          />
        </>
      )}
      {loading ? (
        <span
          role="status"
          aria-label={t('sync.loading')}
          className="absolute inset-0 flex items-center justify-center"
        >
          <LoaderCircle
            aria-hidden="true"
            className="h-8 w-8 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        </span>
      ) : (
        (!source || failed) &&
        (chat ? (
          <MessageCircle aria-hidden="true" className="h-10 w-10 text-muted-foreground/30" />
        ) : (
          <span
            aria-hidden="true"
            className="absolute inset-0 bg-[radial-gradient(hsl(var(--muted-foreground)/0.28)_1px,transparent_1px)] [background-size:14px_14px]"
          />
        ))
      )}
    </>
  )
}
