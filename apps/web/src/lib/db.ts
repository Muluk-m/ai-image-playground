import { storyboardShotLabel } from '@image-playground/shared'
import type { AssetRecord, Tombstone } from '../features/library/types'
import type { ProductShotJob } from '../features/productShots/types'
import type { StoryboardRecord } from '../features/video/storyboard/types'
import type { VideoTask } from '../features/video/types'
import type { StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { scopedStorageName } from './authScope'

/** 匿名 scope 下的 DB 名，其它 scope 由 scopedStorageName 派生。 */
export const BASE_DB_NAME = 'image-playground'
const DB_VERSION = 11
const STORE_TASKS = 'tasks'
const STORE_IMAGES = 'images'
const STORE_THUMBNAILS = 'thumbnails'
export const STORE_ASSETS = 'assets'
export const STORE_TEMPLATES = 'templates'
export const STORE_REMIX_SETS = 'remix_sets'
export const STORE_BGSWAP_JOBS = 'bgswap_jobs'
export const STORE_VIDEO_TASKS = 'video_tasks'
export const STORE_STORYBOARDS = 'storyboards'
export const DB_STORE_NAMES = [
  STORE_TASKS,
  STORE_IMAGES,
  STORE_THUMBNAILS,
  STORE_ASSETS,
  STORE_TEMPLATES,
  STORE_REMIX_SETS,
  STORE_BGSWAP_JOBS,
  STORE_VIDEO_TASKS,
  STORE_STORYBOARDS,
] as const
export type DbStoreName = (typeof DB_STORE_NAMES)[number]
const THUMBNAIL_MAX_SIZE = 720
const THUMBNAIL_QUALITY = 0.9
const THUMBNAIL_VERSION = 2

export const CURRENT_THUMBNAIL_VERSION = THUMBNAIL_VERSION

export function openNamedDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const request = e.target as IDBOpenDBRequest
      const db = request.result
      for (const storeName of DB_STORE_NAMES) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' })
        }
      }
      if (e.oldVersion < 8 && request.transaction) backfillUpdatedAt(request.transaction)
      if (e.oldVersion < 11 && request.transaction) upgradeStoryboards(request.transaction)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** v8：素材与模板记录新增 updatedAt，旧记录取 createdAt。 */
function backfillUpdatedAt(tx: IDBTransaction): void {
  for (const storeName of [STORE_ASSETS, STORE_TEMPLATES]) {
    const cursorRequest = tx.objectStore(storeName).openCursor()
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) return
      const record = cursor.value as { createdAt?: number; updatedAt?: number }
      if (record.updatedAt === undefined) {
        cursor.update({ ...record, updatedAt: record.createdAt ?? Date.now() })
      }
      cursor.continue()
    }
  }
}

/** v10 之前的分镜：一镜一条视频，没有时间轴，也没有整条视频的提示词。 */
interface LegacyStoryboard {
  summary: string
  videoPrompt?: string
  shots: { no: number; description: string; camera: string; seconds: number }[]
}

type StoredStoryboard = LegacyStoryboard & {
  referenceImageId?: string | null
  referenceImageIds?: string[]
}

/**
 * 分镜记录的历次改形。它们必须共用一趟游标：两趟并行游标读的是同一条旧记录，
 * 后写的那趟会把前一趟的结果整条盖掉。每一步认形状不认版本号，所以补过的记录会跳过。
 */
function upgradeStoryboards(tx: IDBTransaction): void {
  const cursorRequest = tx.objectStore(STORE_STORYBOARDS).openCursor()
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (!cursor) return
    let record = cursor.value as StoredStoryboard
    let changed = false
    if (record.videoPrompt === undefined) {
      record = timedStoryboard(record)
      changed = true
    }
    if (record.referenceImageIds === undefined) {
      const { referenceImageId, ...rest } = record
      record = { ...rest, referenceImageIds: referenceImageId ? [referenceImageId] : [] }
      changed = true
    }
    if (changed) cursor.update(record)
    cursor.continue()
  }
}

function timedStoryboard(record: LegacyStoryboard) {
  let startSeconds = 0
  const shots = record.shots.map((shot) => {
    const timed = { ...shot, startSeconds }
    startSeconds += shot.seconds
    return timed
  })
  return {
    ...record,
    totalSeconds: startSeconds,
    videoPrompt: [
      record.summary,
      ...shots.map(
        (shot) => `${storyboardShotLabel(shot.no, shot)}：${shot.description}，${shot.camera}`,
      ),
    ].join('\n'),
    shotImagesRequested: true,
    videoTaskId: null,
    shots,
  }
}

function openDB(): Promise<IDBDatabase> {
  return openNamedDb(scopedStorageName(BASE_DB_NAME))
}

export function dbTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const req = fn(store)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

// ===== Tasks =====

export function getAllTasks(): Promise<TaskRecord[]> {
  return dbTransaction(STORE_TASKS, 'readonly', (s) => s.getAll())
}

export function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.put(task))
}

export function deleteTask(id: string): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.delete(id))
}

export function clearTasks(): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.clear())
}

// ===== Images =====

export function getImage(id: string): Promise<StoredImage | undefined> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.get(id))
}

export function getStoredImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  return dbTransaction(STORE_THUMBNAILS, 'readonly', (s) => s.get(id))
}

export async function getStoredFreshImageThumbnail(
  id: string,
): Promise<StoredImageThumbnail | undefined> {
  const thumbnail = await getStoredImageThumbnail(id)
  return thumbnail?.thumbnailVersion === THUMBNAIL_VERSION ? thumbnail : undefined
}

export function putImageThumbnail(thumbnail: StoredImageThumbnail): Promise<IDBValidKey> {
  return dbTransaction(STORE_THUMBNAILS, 'readwrite', (s) => s.put(thumbnail))
}

export async function getImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const existingThumbnail = await getStoredImageThumbnail(id)
  if (existingThumbnail?.thumbnailVersion === THUMBNAIL_VERSION) {
    const image = await getImage(id)
    if (
      image &&
      (!image.width || !image.height) &&
      existingThumbnail.width &&
      existingThumbnail.height
    ) {
      await putImage({ ...image, width: existingThumbnail.width, height: existingThumbnail.height })
    }
    return existingThumbnail
  }

  const image = await getImage(id)
  if (!image) return undefined
  const legacyImage = image as StoredImage & Partial<StoredImageThumbnail>
  if (legacyImage.thumbnailDataUrl && legacyImage.thumbnailVersion === THUMBNAIL_VERSION) {
    const thumbnail: StoredImageThumbnail = {
      id,
      thumbnailDataUrl: legacyImage.thumbnailDataUrl,
      width: legacyImage.width,
      height: legacyImage.height,
      thumbnailVersion: THUMBNAIL_VERSION,
    }
    await putImageThumbnail(thumbnail)
    if ((!image.width || !image.height) && thumbnail.width && thumbnail.height) {
      await putImage({ ...image, width: thumbnail.width, height: thumbnail.height })
    }
    return thumbnail
  }

  const metadata = await safeCreateImageThumbnail(image.dataUrl)
  if (!metadata.thumbnailDataUrl) return undefined
  const thumbnail: StoredImageThumbnail = {
    id,
    thumbnailDataUrl: metadata.thumbnailDataUrl,
    width: metadata.width,
    height: metadata.height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
  await putImageThumbnail(thumbnail)
  if (
    metadata.width &&
    metadata.height &&
    (image.width !== metadata.width || image.height !== metadata.height)
  ) {
    await putImage({ ...image, width: metadata.width, height: metadata.height })
  }
  return thumbnail
}

/** 只问在不在，不把整张图读出来。 */
export function hasImage(id: string): Promise<boolean> {
  return dbTransaction<IDBValidKey | undefined>(STORE_IMAGES, 'readonly', (s) => s.getKey(id)).then(
    Boolean,
  )
}

export function getAllImages(): Promise<StoredImage[]> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.getAll())
}

export function getAllImageIds(): Promise<string[]> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.map(String),
  )
}

/** 图片由各功能的持久化记录共同持有，不能只凭生成历史判成孤立图片。只读元数据，不读图片本体。 */
export async function getReferencedImageIds(tasks: readonly TaskRecord[]): Promise<Set<string>> {
  const [assets, jobs, videos, storyboards] = await Promise.all([
    dbTransaction<Array<AssetRecord | Tombstone>>(STORE_ASSETS, 'readonly', (s) => s.getAll()),
    dbTransaction<ProductShotJob[]>(STORE_BGSWAP_JOBS, 'readonly', (s) => s.getAll()),
    dbTransaction<VideoTask[]>(STORE_VIDEO_TASKS, 'readonly', (s) => s.getAll()),
    dbTransaction<StoryboardRecord[]>(STORE_STORYBOARDS, 'readonly', (s) => s.getAll()),
  ])
  const ids = new Set<string>()
  const add = (id: string | null | undefined) => {
    if (id) ids.add(id)
  }
  for (const task of tasks) {
    for (const id of task.inputImageIds || []) add(id)
    add(task.maskImageId)
    add(task.maskTargetImageId)
    for (const id of task.outputImages || []) add(id)
    for (const id of task.transparentOriginalImages || []) add(id)
  }
  for (const asset of assets) {
    if (!('deletedAt' in asset)) add(asset.imageId)
  }
  for (const job of jobs) {
    for (const image of job.images) {
      add(image.imageId)
      const matte = image.sourceMatte
      add(matte?.previewImageId)
      if (matte && matte.status !== 'failed') {
        add(matte.alphaImageId)
        add(matte.targetImageId)
      }
      for (const version of image.versions) {
        add(version.maskImageId)
        add(version.maskTargetImageId)
        add(version.mattePreviewImageId)
        if (version.workflow) {
          add(version.workflow.sourceImageId)
          for (const id of version.workflow.inputImageIds) add(id)
        }
      }
    }
  }
  for (const video of videos) {
    add(video.firstFrameImageId)
    add(video.lastFrameImageId)
  }
  for (const storyboard of storyboards) {
    for (const imageId of storyboard.referenceImageIds) add(imageId)
    for (const shot of storyboard.shots) add(shot.imageId)
  }
  return ids
}

export function putImage(image: StoredImage): Promise<IDBValidKey> {
  return dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.put(image))
}

export function deleteImage(id: string): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).delete(id)
        tx.objectStore(STORE_THUMBNAILS).delete(id)
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

export function clearImages(): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).clear()
        tx.objectStore(STORE_THUMBNAILS).clear()
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

// ===== Image hashing & dedup =====

export async function hashDataUrl(dataUrl: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return hashDataUrlFallback(dataUrl)
  }

  const data = new TextEncoder().encode(dataUrl)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hashDataUrlFallback(dataUrl: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193

  for (let i = 0; i < dataUrl.length; i++) {
    const code = dataUrl.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2d)
  }

  return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 存储图片，若已存在（按 hash 去重）则跳过。
 * 返回 image id。
 */
export async function storeImage(
  dataUrl: string,
  source: NonNullable<StoredImage['source']> = 'upload',
): Promise<string> {
  const id = await hashDataUrl(dataUrl)
  const existing = await getImage(id)
  if (!existing) {
    const thumbnail = await safeCreateImageThumbnail(dataUrl)
    await putImage({
      id,
      dataUrl,
      createdAt: Date.now(),
      source,
      width: thumbnail.width,
      height: thumbnail.height,
    })
    if (thumbnail.thumbnailDataUrl) {
      await putImageThumbnail({
        id,
        thumbnailDataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: THUMBNAIL_VERSION,
      })
    }
  } else if ((await getStoredImageThumbnail(id))?.thumbnailVersion !== THUMBNAIL_VERSION) {
    const thumbnail = await safeCreateImageThumbnail(existing.dataUrl)
    if (
      thumbnail.width &&
      thumbnail.height &&
      (existing.width !== thumbnail.width || existing.height !== thumbnail.height)
    ) {
      await putImage({ ...existing, width: thumbnail.width, height: thumbnail.height })
    }
    if (thumbnail.thumbnailDataUrl) {
      await putImageThumbnail({
        id,
        thumbnailDataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: THUMBNAIL_VERSION,
      })
    }
  }
  return id
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = dataUrl
  })
}

async function createImageThumbnail(dataUrl: string): Promise<Omit<StoredImageThumbnail, 'id'>> {
  const image = await loadImage(dataUrl)
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width <= 0 || height <= 0) throw new Error('图片尺寸无效')

  const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  return {
    thumbnailDataUrl: canvas.toDataURL('image/webp', THUMBNAIL_QUALITY),
    width,
    height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
}

async function safeCreateImageThumbnail(
  dataUrl: string,
): Promise<Partial<Omit<StoredImageThumbnail, 'id'>>> {
  try {
    return await createImageThumbnail(dataUrl)
  } catch {
    return {}
  }
}
