import type {
  AgentToolArtifact,
  ProductionDocument,
  ProductionGenerationView,
  ProductionMediaReference,
} from '@image-playground/shared'
import { strToU8, Zip, ZipPassThrough } from 'fflate'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { scopedStorageName } from '../../../lib/authScope'
import { dataUrlToBlob } from '../../../lib/canvasImage'
import { getCachedMedia, getImage } from '../../../lib/db'
import { imageMimeFromBytes } from '../../../lib/imageBytes'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

// Remote byte-path profiling: 500 MiB peaked at 2.03 GiB RSS; keep the first release bounded.
export const PRODUCTION_EXPORT_MAX_BYTES = 128 * 1024 * 1024
export interface ProductionExportResource {
  key: string
  reference: ProductionMediaReference
  name: string
  owners: string[]
}
export interface ProductionExportSnapshot {
  document: ProductionDocument
  resources: ProductionExportResource[]
  scope: string
  generations?: readonly Pick<
    ProductionGenerationView,
    | 'draftId'
    | 'draftRevision'
    | 'production'
    | 'model'
    | 'prompt'
    | 'params'
    | 'video'
    | 'references'
    | 'taskId'
    | 'artifacts'
  >[]
}
export interface ProductionExportItem extends ProductionExportResource {
  bytes: number | null
  mime: string | null
  status: 'available' | 'missing'
}
export interface ProductionExportInspection {
  snapshot: ProductionExportSnapshot
  items: ProductionExportItem[]
}
function referenceKey(ref: ProductionMediaReference): string {
  return ref.kind === 'artifact'
    ? `artifact:${ref.artifactId}`
    : ref.kind === 'media'
      ? `media:${ref.mediaId}`
      : `asset:${ref.imageId}`
}
function assertScope(snapshot: ProductionExportSnapshot) {
  if (snapshot.scope !== scopedStorageName('production-export'))
    throw new Error('production_export_scope_changed')
}
export function freezeProductionExport(
  document: ProductionDocument,
  extraCandidates: readonly AgentToolArtifact[] = [],
  generations: readonly ProductionGenerationView[] = [],
): ProductionExportSnapshot {
  const frozen = structuredClone(document)
  const map = new Map<string, ProductionExportResource>()
  const add = (reference: ProductionMediaReference | undefined, name: string, owner: string) => {
    if (!reference) return
    const key = referenceKey(reference),
      existing = map.get(key)
    if (existing) {
      if (!existing.owners.includes(owner)) existing.owners.push(owner)
      return
    }
    map.set(key, { key, reference, name, owners: [owner] })
  }
  for (const character of frozen.content.characters ?? [])
    for (const look of character.looks)
      add(look.reference, `${character.name}-${look.name}`, `look:${look.id}`)
  for (const location of frozen.content.locations ?? [])
    add(location.reference, location.name, `location:${location.id}`)
  for (const shot of frozen.content.shots ?? [])
    add(shot.keyframe, shot.description, `shot:${shot.id}`)
  for (const clip of frozen.content.clips ?? []) {
    for (const ref of clip.references) add(ref.reference, clip.name, `clip-reference:${clip.id}`)
    if (clip.adopted)
      add({ kind: 'artifact', artifactId: clip.adopted.artifactId }, clip.name, `clip:${clip.id}`)
  }
  for (const artifact of extraCandidates)
    add(
      { kind: 'artifact', artifactId: artifact.artifactId },
      artifact.artifactId,
      `candidate:${artifact.artifactId}`,
    )
  return {
    document: frozen,
    generations: structuredClone(
      generations.map(
        ({
          draftId,
          draftRevision,
          production,
          model,
          prompt,
          params,
          video,
          references,
          taskId,
          artifacts,
        }) => ({
          draftId,
          draftRevision,
          production,
          model,
          prompt,
          params,
          video,
          references,
          taskId,
          artifacts,
        }),
      ),
    ),
    resources: [...map.values()],
    scope: scopedStorageName('production-export'),
  }
}
function base(snapshot: ProductionExportSnapshot) {
  return `${bffBaseUrl()}/api/agent/conversations/${encodeURIComponent(snapshot.document.conversationId)}/production/export`
}
export function productionExportResourceUrl(
  snapshot: ProductionExportSnapshot,
  resource: ProductionExportResource,
  download = false,
): string {
  const ref = resource.reference
  const id =
    ref.kind === 'artifact' ? ref.artifactId : ref.kind === 'media' ? ref.mediaId : ref.imageId
  return `${base(snapshot)}/reference?${new URLSearchParams({ revision: String(snapshot.document.revision), kind: ref.kind, id, ...(download ? { download: 'true' } : {}) })}`
}
async function cachedOriginal(reference: ProductionMediaReference): Promise<Blob | null> {
  try {
    if (reference.kind === 'media') {
      const cached = await getCachedMedia(`${reference.mediaId}:original`)
      return cached ? new Blob([cached.data], { type: cached.contentType }) : null
    }
    if (reference.kind === 'asset') {
      const image = await getImage(reference.imageId)
      return image ? await dataUrlToBlob(image.dataUrl) : null
    }
  } catch {
    /* Cache loss is recoverable via the authorized original endpoint. */
  }
  return null
}
export async function inspectProductionExport(
  snapshot: ProductionExportSnapshot,
  signal: AbortSignal,
): Promise<ProductionExportInspection> {
  signal.throwIfAborted()
  assertScope(snapshot)
  if (!snapshot.resources.length) return { snapshot, items: [] }
  const body: {
    items: {
      reference: ProductionMediaReference
      bytes: number | null
      mime: string | null
      status: 'available' | 'missing'
    }[]
  } = { items: [] }
  for (let offset = 0; offset < snapshot.resources.length; offset += 500) {
    signal.throwIfAborted()
    assertScope(snapshot)
    const response = await authenticatedBffFetch(`${base(snapshot)}/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: snapshot.document.revision,
        references: snapshot.resources.slice(offset, offset + 500).map((one) => one.reference),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    })
    if (!response.ok) throw new Error('production_export_inspect_failed')
    const batch = (await response.json()) as typeof body
    body.items.push(...batch.items)
  }
  assertScope(snapshot)
  signal.throwIfAborted()
  const items: ProductionExportItem[] = []
  for (const resource of snapshot.resources) {
    const metadata = body.items.find((one) => referenceKey(one.reference) === resource.key)
    if (!metadata) throw new Error('production_export_inspect_failed')
    // Inspection has already checked ownership. A retained local original can outlive the server copy.
    const cached = await cachedOriginal(resource.reference)
    assertScope(snapshot)
    signal.throwIfAborted()
    items.push({
      ...resource,
      bytes: cached?.size ?? metadata.bytes,
      mime: cached?.type ?? metadata.mime,
      status: cached ? 'available' : metadata.status,
    })
  }
  return { snapshot, items }
}
function safeName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 70)
  return cleaned || 'resource'
}
function csv(value: unknown): string {
  let text = String(value ?? '')
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}
function extension(mime: string): string | undefined {
  return {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  }[mime]
}
function recognizedMime(bytes: Uint8Array): string | undefined {
  const head = bytes.slice(0, 16)
  const image = imageMimeFromBytes(head.buffer)
  if (image) return image
  if (head.length >= 6 && new TextDecoder().decode(head.slice(0, 6)).match(/^GIF8[79]a$/))
    return 'image/gif'
  if (head.length >= 12 && new TextDecoder().decode(head.slice(4, 8)) === 'ftyp') return 'video/mp4'
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)
    return 'video/webm'
  return undefined
}
async function validateOriginal(
  bytes: Uint8Array,
  mime: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  signal.throwIfAborted()
  if (
    mime === 'image/png' &&
    (bytes.length < 45 || new TextDecoder().decode(bytes.slice(-8, -4)) !== 'IEND')
  )
    throw new Error('corrupt')
  if (
    mime === 'image/jpeg' &&
    (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9)
  )
    throw new Error('corrupt')
  const blob = new Blob([bytes as BlobPart], { type: mime })
  if (mime.startsWith('image/') && typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob).catch(() => {
      throw new Error('corrupt')
    })
    bitmap.close()
    signal.throwIfAborted()
  }
  if (mime.startsWith('video/') && typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.preload = 'metadata'
    try {
      return await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => finish(undefined), 15000)
        const abort = () => finish(undefined)
        const finish = (duration: number | undefined) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          video.onloadedmetadata = null
          video.onerror = null
          if (duration !== undefined) resolve(duration)
          else reject(new Error(signal.aborted ? 'cancelled' : 'corrupt'))
        }
        signal.addEventListener('abort', abort, { once: true })
        video.onerror = () => finish(undefined)
        video.onloadedmetadata = () =>
          finish(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined)
        video.src = url
      })
    } finally {
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
    }
  }
  return undefined
}
async function readOriginal(
  plan: ProductionExportInspection,
  item: ProductionExportItem,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; actualDurationSeconds?: number }> {
  const cached = await cachedOriginal(item.reference)
  assertScope(plan.snapshot)
  signal.throwIfAborted()
  const response = cached
    ? new Response(cached)
    : await authenticatedBffFetch(productionExportResourceUrl(plan.snapshot, item), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        cache: 'no-store',
      })
  if (!response.ok || !response.body) throw new Error('missing')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      assertScope(plan.snapshot)
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > PRODUCTION_EXPORT_MAX_BYTES || (item.bytes !== null && size > item.bytes))
        throw new Error('size')
      parts.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (!size || size !== item.bytes) throw new Error('size')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  if (recognizedMime(bytes) !== item.mime) throw new Error('corrupt')
  const actualDurationSeconds = await validateOriginal(bytes, item.mime!, signal)
  return { bytes, ...(actualDurationSeconds !== undefined ? { actualDurationSeconds } : {}) }
}
export async function buildProductionZip(
  plan: ProductionExportInspection,
  options: {
    signal: AbortSignal
    allowPartial: boolean
    onProgress?: (done: number, total: number) => void
  },
): Promise<{ blob: Blob; missing: { key: string; name: string; reason: string }[] }> {
  const { signal, allowPartial, onProgress } = options
  signal.throwIfAborted()
  assertScope(plan.snapshot)
  const selected = plan.items.filter((one) => one.status === 'available')
  if (
    selected.some((one) => one.bytes === null || !Number.isSafeInteger(one.bytes) || one.bytes < 0)
  )
    throw new Error('production_export_unknown_size')
  if (selected.reduce((total, one) => total + (one.bytes ?? 0), 0) > PRODUCTION_EXPORT_MAX_BYTES)
    throw new Error('production_export_too_large')
  const missing = plan.items
    .filter((one) => one.status === 'missing')
    .map((one) => ({ key: one.key, name: one.name, reason: 'missing' }))
  if (missing.length && !allowPartial) throw new Error('production_export_missing')
  const chunks: Uint8Array[] = []
  let zipError: Error | undefined
  let ended = false
  const zip = new Zip((error, data, final) => {
    if (error) zipError = error
    else chunks.push(data)
    if (final) ended = true
  })
  const add = (path: string, bytes: Uint8Array) => {
    const file = new ZipPassThrough(path)
    zip.add(file)
    file.push(bytes, true)
    if (zipError) throw zipError
  }
  const resources: (ProductionExportItem & { path: string; actualDurationSeconds?: number })[] = []
  const cancel = () => zip.terminate()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    let done = 0
    for (const item of plan.items) {
      signal.throwIfAborted()
      assertScope(plan.snapshot)
      if (item.status === 'available') {
        try {
          const { bytes, actualDurationSeconds } = await readOriginal(plan, item, signal)
          const ext = extension(item.mime ?? '')
          if (!ext) throw new Error('unsupported')
          const path = `${item.mime?.startsWith('video/') ? 'videos' : 'images'}/${String(done + 1).padStart(3, '0')}-${safeName(item.name)}.${ext}`
          add(path, bytes)
          resources.push({
            ...item,
            path,
            ...(actualDurationSeconds !== undefined ? { actualDurationSeconds } : {}),
          })
        } catch (error) {
          if (signal.aborted) throw error
          assertScope(plan.snapshot)
          if (!allowPartial) throw new Error('production_export_missing')
          missing.push({
            key: item.key,
            name: item.name,
            reason:
              error instanceof Error && ['size', 'corrupt', 'unsupported'].includes(error.message)
                ? error.message
                : 'missing',
          })
        }
      }
      done++
      onProgress?.(done, plan.items.length)
    }
    const { document } = plan.snapshot
    const content = document.content
    const pathFor = (ref: ProductionMediaReference | undefined) =>
      ref ? (resources.find((one) => one.key === referenceKey(ref))?.path ?? '') : ''
    add(
      'script.md',
      strToU8(
        `# ${content.title}\n\n## 故事设定\n\n${content.setting}\n\n## 大纲\n\n${content.outline}\n\n${content.scenes.map((scene) => `## ${scene.title}\n\n${scene.body}`).join('\n\n')}\n`,
      ),
    )
    add(
      'characters-and-locations.md',
      strToU8(
        `${(content.characters ?? []).map((character) => `# ${character.name}\n${character.description}\n\n${character.looks.map((look) => `## ${look.name}\n${look.description}\n${pathFor(look.reference)}`).join('\n\n')}`).join('\n\n')}\n\n${(content.locations ?? []).map((location) => `# ${location.name}\n${location.description}\n${pathFor(location.reference)}`).join('\n\n')}\n`,
      ),
    )
    const columns = [
      'order',
      'shotId',
      'sceneId',
      'lookIds',
      'locationId',
      'description',
      'dialogue',
      'camera',
      'expectedSeconds',
      'keyframePath',
      'clipIds',
    ]
    const rows = (content.shots ?? []).map((shot, index) => [
      index + 1,
      shot.id,
      shot.scriptSceneId,
      shot.lookIds.join('|'),
      shot.locationId,
      shot.description,
      shot.dialogue,
      shot.camera,
      shot.durationSeconds,
      pathFor(shot.keyframe),
      (content.clips ?? [])
        .filter((clip) => clip.shotIds.includes(shot.id))
        .map((clip) => clip.id)
        .join('|'),
    ])
    add(
      'storyboard.csv',
      strToU8(`\ufeff${[columns, ...rows].map((row) => row.map(csv).join(',')).join('\r\n')}\r\n`),
    )
    const manifest = {
      schemaVersion: 1,
      documentId: document.id,
      conversationId: document.conversationId,
      revision: document.revision,
      complete: missing.length === 0,
      selection: plan.items.map((one) => one.key),
      content,
      generations: plan.snapshot.generations?.filter((generation) =>
        generation.artifacts.some((artifact) =>
          plan.items.some((item) => item.key === `artifact:${artifact.artifactId}`),
        ),
      ),
      resources: resources.map(
        ({ key, reference, name, owners, path, bytes, mime, actualDurationSeconds }) => ({
          key,
          reference,
          name,
          owners,
          path,
          bytes,
          mime,
          ...(actualDurationSeconds !== undefined ? { actualDurationSeconds } : {}),
        }),
      ),
      missing,
    }
    add('manifest.json', strToU8(JSON.stringify(manifest, null, 2)))
    if (missing.length) add('missing.json', strToU8(JSON.stringify(missing, null, 2)))
    add(
      'README.md',
      strToU8(
        `# Muvloom 创作资源包\n\n制作修订：V${document.revision}\n\n${missing.length ? '这是部分资源包；缺失原件见 missing.json。' : '已导出所选可用资源。'}\n\nscript.md：剧本；characters-and-locations.md：角色与场景；storyboard.csv：分镜；manifest.json：身份、修订与文件对应关系。\n\n视频为独立原片，预计时长位于片段计划，实际时长以播放器读取结果为准。本包不包含剪映工程、合成电影或自动字幕。\n`,
      ),
    )
    signal.throwIfAborted()
    assertScope(plan.snapshot)
    zip.end()
    if (zipError) throw zipError
    if (!ended) throw new Error('production_export_zip_failed')
    return { blob: new Blob(chunks as BlobPart[], { type: 'application/zip' }), missing }
  } finally {
    signal.removeEventListener('abort', cancel)
    zip.terminate()
  }
}
