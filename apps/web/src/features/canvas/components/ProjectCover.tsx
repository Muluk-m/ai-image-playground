import { useCallback, useState } from 'react'
import MediaImage from '../../../components/MediaImage'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'

export default function ProjectCover({
  source,
  chat,
  pending = false,
  fit = 'contain',
}: {
  source?: string
  chat: boolean
  pending?: boolean
  fit?: 'contain' | 'cover'
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
      {source && (
        <>
          {fit === 'contain' && (
            <MediaImage
              src={source}
              alt=""
              loading="lazy"
              aria-hidden="true"
              className={`absolute inset-0 h-full w-full scale-125 object-cover blur-2xl saturate-150 ${failed ? 'opacity-0' : 'opacity-50'}`}
            />
          )}
          <MediaImage
            src={source}
            alt=""
            loading="lazy"
            onLoad={() => setSettled({ source, failed: false })}
            onError={() => setSettled({ source, failed: true })}
            onResolveError={fail}
            className={`relative h-full w-full ${fit === 'cover' ? 'object-cover' : 'object-contain'} ${loading || failed ? 'opacity-0' : ''}`}
          />
        </>
      )}
      {loading ? (
        <span
          role="status"
          aria-label={t('sync.loading')}
          className="absolute inset-0 flex items-center justify-center"
        >
          <Icon
            name="loading"
            size="lg"
            className="animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        </span>
      ) : (
        (!source || failed) && (
          <Icon name={chat ? 'chat' : 'image'} size="lg" className="text-muted-foreground" />
        )
      )}
    </>
  )
}
