import { type ImgHTMLAttributes, useEffect, useState } from 'react'
import { scopedStorageName } from '../lib/authScope'
import { mediaIdentity, resolveMediaSource } from '../lib/cloudMedia'
import { BASE_DB_NAME } from '../lib/db'
import {
  localAttachmentFailure,
  localAttachmentIdentity,
  localAttachmentPreview,
  onLocalAttachmentReleased,
  onLocalAttachmentUploadChanged,
  readAttachmentUpload,
} from '../lib/localAttachmentSources'
import { bffBaseUrl } from '../lib/runtimeConfig'

/** Local attachment originals stay on disk; render a cached thumbnail or the cloud preview. */
export default function MediaImage({
  src,
  onResolveError,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { onResolveError?: () => void }) {
  const scope = scopedStorageName(BASE_DB_NAME)
  const backend = bffBaseUrl()
  const [resolved, setResolved] = useState<{
    source: string
    value: string
    scope: string
    backend: string
  }>()
  useEffect(() => {
    let current = true
    let generation = 0
    const load = async () => {
      const requested = ++generation
      let localPreview: Promise<string | undefined> | undefined
      let localPreviewAvailable = false
      let cloudPreviewAvailable = false
      try {
        if (!src) return
        let source = src
        if (localAttachmentIdentity(src)) {
          localPreview = localAttachmentPreview(src)
          void localPreview?.then((value) => {
            if (
              value &&
              !cloudPreviewAvailable &&
              current &&
              requested === generation &&
              scope === scopedStorageName(BASE_DB_NAME) &&
              backend === bffBaseUrl()
            ) {
              localPreviewAvailable = true
              setResolved({ source: src, value, scope, backend })
            }
          })
          const upload = await readAttachmentUpload(src, backend)
          if (upload?.state !== 'ready' || localPreviewAvailable) return
          source = `aip-media:${upload.result.id}`
        }
        if (
          !mediaIdentity(source) ||
          !current ||
          requested !== generation ||
          scope !== scopedStorageName(BASE_DB_NAME) ||
          backend !== bffBaseUrl()
        )
          return
        const value = await resolveMediaSource(source, 'display')
        if (
          current &&
          requested === generation &&
          scope === scopedStorageName(BASE_DB_NAME) &&
          backend === bffBaseUrl()
        ) {
          cloudPreviewAvailable = true
          setResolved({ source: src, value, scope, backend })
        }
      } catch {
        const fallback = await localPreview?.catch(() => undefined)
        if (
          current &&
          requested === generation &&
          scope === scopedStorageName(BASE_DB_NAME) &&
          backend === bffBaseUrl()
        ) {
          if (!fallback && !localPreviewAvailable) onResolveError?.()
        }
      }
    }
    const unsubscribe = onLocalAttachmentUploadChanged((change) => {
      if (
        (!change.source || change.source === src) &&
        change.storageScope === scope &&
        (change.backend === undefined || change.backend === backend)
      )
        void load()
    })
    const release = onLocalAttachmentReleased((change) => {
      if (change.storageScope === scope && src && change.sources.includes(src)) {
        generation++
        setResolved(undefined)
      }
    })
    void load()
    return () => {
      current = false
      unsubscribe()
      release()
    }
  }, [src, scope, backend, onResolveError])
  const deferred =
    src && (mediaIdentity(src) || localAttachmentIdentity(src) || localAttachmentFailure(src))
  const value = deferred
    ? resolved?.source === src && resolved.scope === scope && resolved.backend === backend
      ? resolved.value
      : undefined
    : src
  return <img {...props} src={value} />
}
