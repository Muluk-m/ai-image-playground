import { randomUUID } from 'node:crypto'
import { OAUTH_ONLY_PASSWORD_HASH } from '@image-playground/db'
import {
  type AccountProfileView,
  AVATAR_EDGE_PX,
  AVATAR_MAX_BYTES,
  bioError,
  nicknameError,
} from '@image-playground/shared'
import { eq, inArray } from 'drizzle-orm'
import sharp from 'sharp'
import { db, schema } from '../db/client'
import { accountProfileView } from './account-profile-view'
import { durableMediaStore } from './durableMediaStore'
import { detectMediaMime } from './imageArchive'
import { log } from './logger'
import { objectStore } from './objectStore'
import { loadPrivateBffOverlay } from './private-overlay'
import { assetOwnerPrefix } from './sync-assets'

export type AccountProfileErrorCode =
  | 'unauthorized'
  | 'nickname_invalid'
  | 'nickname_blocked'
  | 'bio_invalid'
  | 'avatar_type'
  | 'avatar_too_large'
  | 'avatar_invalid'
  | 'current_password_required'
  | 'invalid_credentials'
  | 'account_delete_blocked'

export class AccountProfileError extends Error {
  constructor(
    readonly code: AccountProfileErrorCode,
    readonly status: number,
  ) {
    super(code)
    this.name = 'AccountProfileError'
  }
}

const AVATAR_TYPES: Record<string, true | undefined> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
}

/** 一张手机原图大约一千两百万像素；再往上就当解压炸弹拒掉。 */
const AVATAR_PIXEL_LIMIT = 24_000_000

const profileColumns = {
  id: schema.users.id,
  username: schema.users.username,
  nickname: schema.users.nickname,
  bio: schema.users.bio,
  avatar_key: schema.users.avatar_key,
  updated_at: schema.users.updated_at,
}

export function avatarObjectKey(userId: string): string {
  return `${assetOwnerPrefix(userId)}avatar.webp`
}

function databaseSqlState(error: unknown): string | null {
  const databaseError =
    error !== null && typeof error === 'object' && 'cause' in error ? error.cause : error
  if (databaseError === null || typeof databaseError !== 'object' || !('errno' in databaseError)) {
    return null
  }
  return String(databaseError.errno)
}

export async function getAccountProfile(userId: string): Promise<AccountProfileView> {
  const [row] = await db
    .select(profileColumns)
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)
  if (!row) throw new AccountProfileError('unauthorized', 401)
  return accountProfileView(row)
}

export async function updateAccountProfile(
  userId: string,
  input: { nickname?: string | null; bio?: string | null },
): Promise<AccountProfileView> {
  const patch: { nickname?: string; bio?: string | null; updated_at?: number } = {}
  if (input.nickname !== undefined) {
    if (input.nickname === null) throw new AccountProfileError('nickname_invalid', 400)
    const error = nicknameError(input.nickname)
    if (error) throw new AccountProfileError(error, 400)
    patch.nickname = input.nickname.trim()
  }
  if (input.bio !== undefined) {
    if (input.bio !== null && bioError(input.bio)) throw new AccountProfileError('bio_invalid', 400)
    const trimmed = input.bio?.trim() ?? ''
    patch.bio = trimmed ? trimmed : null
  }
  if (patch.nickname === undefined && patch.bio === undefined) return getAccountProfile(userId)

  patch.updated_at = Date.now()
  try {
    const [row] = await db
      .update(schema.users)
      .set(patch)
      .where(eq(schema.users.id, userId))
      .returning(profileColumns)
    if (!row) throw new AccountProfileError('unauthorized', 401)
    return accountProfileView(row)
  } catch (error) {
    if (error instanceof AccountProfileError) throw error
    if (databaseSqlState(error) === '23514') {
      throw new AccountProfileError(
        patch.nickname === undefined ? 'bio_invalid' : 'nickname_invalid',
        400,
      )
    }
    throw error
  }
}

function normalizeDeclaredType(value: string): string | null {
  const type = value.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!type || type === 'application/octet-stream') return null
  if (type === 'image/jpg') return 'image/jpeg'
  return type
}

export async function readAvatarUpload(
  request: Request,
): Promise<{ bytes: Uint8Array; declaredType: string }> {
  const headerLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(headerLength) && headerLength > AVATAR_MAX_BYTES) {
    throw new AccountProfileError('avatar_too_large', 413)
  }
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) throw new AccountProfileError('avatar_type', 400)
    if (file.size > AVATAR_MAX_BYTES) throw new AccountProfileError('avatar_too_large', 413)
    return { bytes: new Uint8Array(await file.arrayBuffer()), declaredType: file.type }
  }
  const declared = normalizeDeclaredType(contentType)
  if (!declared || !AVATAR_TYPES[declared]) throw new AccountProfileError('avatar_type', 400)
  const bytes = new Uint8Array(await request.arrayBuffer())
  return { bytes, declaredType: declared }
}

export async function encodeAvatar(bytes: Uint8Array, declaredType: string): Promise<Uint8Array> {
  if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) {
    throw new AccountProfileError(
      bytes.byteLength > AVATAR_MAX_BYTES ? 'avatar_too_large' : 'avatar_type',
      bytes.byteLength > AVATAR_MAX_BYTES ? 413 : 400,
    )
  }
  const sniffed = detectMediaMime(bytes)
  const declared = normalizeDeclaredType(declaredType)
  if (!sniffed || !AVATAR_TYPES[sniffed] || (declared !== null && declared !== sniffed)) {
    throw new AccountProfileError('avatar_type', 400)
  }
  try {
    const observed = await sharp(bytes, {
      limitInputPixels: AVATAR_PIXEL_LIMIT,
      animated: false,
    }).metadata()
    if ((observed.pages ?? 1) > 1) throw new AccountProfileError('avatar_invalid', 422)
    const webp = await sharp(bytes, { limitInputPixels: AVATAR_PIXEL_LIMIT, animated: false })
      .rotate()
      .resize(AVATAR_EDGE_PX, AVATAR_EDGE_PX, { fit: 'cover', position: 'centre' })
      .webp({ quality: 80 })
      .toBuffer()
    return new Uint8Array(webp)
  } catch (error) {
    if (error instanceof AccountProfileError) throw error
    throw new AccountProfileError('avatar_invalid', 422)
  }
}

export async function saveAccountAvatar(
  userId: string,
  bytes: Uint8Array,
  declaredType: string,
): Promise<AccountProfileView> {
  const webp = await encodeAvatar(bytes, declaredType)
  const key = avatarObjectKey(userId)
  await objectStore().write(key, webp, 'image/webp')
  const [row] = await db
    .update(schema.users)
    .set({ avatar_key: key, updated_at: Date.now() })
    .where(eq(schema.users.id, userId))
    .returning(profileColumns)
  if (!row) throw new AccountProfileError('unauthorized', 401)
  return accountProfileView(row)
}

export async function readAccountAvatar(userId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const [row] = await db
    .select({ avatar_key: schema.users.avatar_key, status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)
  if (!row || row.status !== 'active' || !row.avatar_key) return null
  try {
    return await objectStore().read(row.avatar_key)
  } catch {
    return null
  }
}

async function removeAccountObjects(userId: string, taskIds: readonly string[]): Promise<void> {
  const jobs: Array<Promise<void>> = [
    objectStore().deletePrefix(assetOwnerPrefix(userId)),
    ...taskIds.map((taskId) => objectStore().deletePrefix(`${taskId}/`)),
  ]
  try {
    const durable = durableMediaStore()
    jobs.push(durable.deletePrefix(`objects/${userId}/`))
    for (const taskId of taskIds) jobs.push(durable.deletePrefix(`${taskId}/`))
  } catch (error) {
    log.warn(
      { event: 'account.storage_cleanup_failed', userId, err: error },
      'account storage cleanup failed',
    )
  }
  const results = await Promise.allSettled(jobs)
  for (const result of results) {
    if (result.status === 'rejected') {
      log.warn(
        { event: 'account.storage_cleanup_failed', userId, err: result.reason },
        'account storage cleanup failed',
      )
    }
  }
}

/** 删掉账号和挂在上面的作品。有密码时必须交出当前密码；只剩第三方登录时会话本身就是凭证。 */
export async function deleteOwnAccount(
  userId: string,
  password: string | undefined,
): Promise<void> {
  const [user] = await db
    .select({ password_hash: schema.users.password_hash })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)
  if (!user) throw new AccountProfileError('unauthorized', 401)

  const hasPassword = user.password_hash !== OAUTH_ONLY_PASSWORD_HASH
  if (hasPassword) {
    if (!password) throw new AccountProfileError('current_password_required', 400)
    const matches = await Bun.password.verify(password, user.password_hash).catch(() => false)
    if (!matches) throw new AccountProfileError('invalid_credentials', 401)
  }

  let taskIds: string[] = []
  try {
    taskIds = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ password_hash: schema.users.password_hash })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for('update')
        .limit(1)
      if (!current) throw new AccountProfileError('unauthorized', 401)
      if (hasPassword && current.password_hash !== user.password_hash) {
        throw new AccountProfileError('invalid_credentials', 401)
      }
      if (!hasPassword && current.password_hash !== OAUTH_ONLY_PASSWORD_HASH) {
        throw new AccountProfileError('current_password_required', 400)
      }

      // 私有账本如果外键指着 users，要在删用户之前把自己的行清掉。缺席时公开库照样能删。
      await (await loadPrivateBffOverlay()).taskHooks.onUserDeleted?.({ tx, userId })

      const analyses = await tx
        .select({ task_id: schema.analysis_tasks.task_id })
        .from(schema.analysis_tasks)
        .where(eq(schema.analysis_tasks.user_id, userId))
      if (analyses.length > 0) {
        await tx.delete(schema.analysis_model_calls).where(
          inArray(
            schema.analysis_model_calls.task_id,
            analyses.map((row) => row.task_id),
          ),
        )
        await tx.delete(schema.analysis_tasks).where(eq(schema.analysis_tasks.user_id, userId))
      }

      // tasks.user_id 是 NO ACTION，不先摘掉就删不掉用户。
      const tasks = await tx
        .delete(schema.tasks)
        .where(eq(schema.tasks.user_id, userId))
        .returning({ id: schema.tasks.id })
      await tx.insert(schema.operator_audits).values({
        id: randomUUID(),
        operator_id: userId,
        action: 'user.delete',
        target_type: 'user',
        target_id: userId,
        details: { tasks_deleted: tasks.length },
        created_at: Date.now(),
      })
      const deleted = await tx
        .delete(schema.users)
        .where(eq(schema.users.id, userId))
        .returning({ id: schema.users.id })
      if (deleted.length === 0) throw new AccountProfileError('unauthorized', 401)
      return tasks.map((row) => row.id)
    })
  } catch (error) {
    if (error instanceof AccountProfileError) throw error
    if (databaseSqlState(error) === '23503') {
      throw new AccountProfileError('account_delete_blocked', 409)
    }
    throw error
  }

  await removeAccountObjects(userId, taskIds)
}
