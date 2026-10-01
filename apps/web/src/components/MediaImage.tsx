import { type ImgHTMLAttributes, useEffect, useState } from 'react'
import { scopedStorageName } from '../lib/authScope'
import { mediaIdentity, resolveMediaSource } from '../lib/cloudMedia'
import { BASE_DB_NAME } from '../lib/db'
import {
  localAttachmentFailure,
  localAttachmentIdentity,
  onLocalAttachmentUploadChanged,
  readAttachmentUpload,
} from '../lib/localAttachmentSources'
import { bffBaseUrl } from '../lib/runtimeConfig'

/** Local attachment originals stay on disk; only their confirmed cloud preview is rendered. */
export default function MediaImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
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
    const load = async () => {
      if (!src) return
      let source = src
      if (localAttachmentIdentity(src)) {
        const upload = await readAttachmentUpload(src, backend)
        if (upload?.state !== 'ready') return
        source = `aip-media:${upload.result.id}`
      }
      if (
        !mediaIdentity(source) ||
        !current ||
        scope !== scopedStorageName(BASE_DB_NAME) ||
        backend !== bffBaseUrl()
      )
        return
      const value = await resolveMediaSource(source, 'preview')
      if (current && scope === scopedStorageName(BASE_DB_NAME) && backend === bffBaseUrl())
        setResolved({ source: src, value, scope, backend })
    }
    const unsubscribe = onLocalAttachmentUploadChanged((change) => {
      if (change.source === src && change.storageScope === scope && change.backend === backend)
        void load().catch(() => {})
    })
    void load().catch(() => {})
    return () => {
      current = false
      unsubscribe()
    }
  }, [src, scope, backend])
  const deferred =
    src && (mediaIdentity(src) || localAttachmentIdentity(src) || localAttachmentFailure(src))
  const value = deferred
    ? resolved?.source === src && resolved.scope === scope && resolved.backend === backend
      ? resolved.value
      : undefined
    : src
  return <img {...props} src={value} />
}
