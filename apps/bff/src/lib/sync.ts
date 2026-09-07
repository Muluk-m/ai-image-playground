import type { UserAssetRow, UserTemplateRow } from '@image-playground/db'
import type {
  SyncAssetChange,
  SyncRequestBody,
  SyncResponseBody,
  SyncSettingsDocument,
  SyncTemplateChange,
  SyncTombstone,
} from '@image-playground/shared'
import { isSyncTombstone } from '@image-playground/shared'
import { and, asc, eq, gt, inArray, or, type SQL } from 'drizzle-orm'
import { db, schema } from '../db/client'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

interface ExistingMeta {
  readonly updated_at: number
  readonly last_used_at: number | null
}

interface IncomingChange {
  readonly id: string
  readonly updatedAt: number
  readonly lastUsedAt?: number
}

/** 每用户版本号：任何一条记录落库都要它 +1，记录上存的就是落库那一刻的值。 */
class VersionCounter {
  private readonly base: number
  private current: number

  constructor(version: number) {
    this.base = version
    this.current = version
  }

  allocate(): number {
    this.current += 1
    return this.current
  }

  get value(): number {
    return this.current
  }

  get changed(): boolean {
    return this.current !== this.base
  }
}

function mergedLastUsedAt(incoming: IncomingChange, existing: ExistingMeta | undefined): number {
  return Math.max(incoming.lastUsedAt ?? 0, existing?.last_used_at ?? 0)
}

interface CollectionWriter<Change extends IncomingChange> {
  write(change: Change, version: number, lastUsedAt: number): Promise<void>
  touch(id: string, version: number, lastUsedAt: number): Promise<void>
}

/**
 * 合并规则只有这一份：`updatedAt` 大者胜，墓碑同样参与；输的一方只有 `lastUsedAt`
 * 更大时才更新那一列。返回被服务端留下的（输掉的）记录 id，它们要回给客户端覆盖。
 */
async function mergeChanges<Change extends IncomingChange>(
  changes: readonly Change[],
  existingById: Map<string, ExistingMeta>,
  version: VersionCounter,
  writer: CollectionWriter<Change>,
): Promise<string[]> {
  const stale: string[] = []
  for (const change of changes) {
    const existing = existingById.get(change.id)
    const lastUsedAt = mergedLastUsedAt(change, existing)
    if (!existing || change.updatedAt > existing.updated_at) {
      await writer.write(change, version.allocate(), lastUsedAt)
    } else if (lastUsedAt > (existing.last_used_at ?? 0)) {
      await writer.touch(change.id, version.allocate(), lastUsedAt)
    } else {
      stale.push(change.id)
    }
  }
  return stale
}

/** 同一 id 在一次请求里出现多次时以最后一条为准。 */
function dedupe<Change extends { id: string }>(changes: readonly Change[] | undefined): Change[] {
  return [...new Map((changes ?? []).map((change) => [change.id, change])).values()]
}

function metaById(rows: readonly (ExistingMeta & { id: string })[]): Map<string, ExistingMeta> {
  return new Map(rows.map((row) => [row.id, row]))
}

function tombstoneOf(row: { id: string; updated_at: number; deleted_at: number }): SyncTombstone {
  return { id: row.id, updatedAt: row.updated_at, deletedAt: row.deleted_at }
}

function templateChange(row: UserTemplateRow): SyncTemplateChange {
  if (row.deleted_at !== null) return tombstoneOf({ ...row, deleted_at: row.deleted_at })
  return {
    id: row.id,
    name: row.name!,
    prompt: row.prompt!,
    assetIds: row.asset_ids ?? [],
    params: row.params ?? {},
    createdAt: row.created_at!,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? row.updated_at,
  }
}

function assetChange(row: UserAssetRow): SyncAssetChange {
  if (row.deleted_at !== null) return tombstoneOf({ ...row, deleted_at: row.deleted_at })
  return {
    id: row.id,
    name: row.name!,
    imageId: row.image_id!,
    createdAt: row.created_at!,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? row.updated_at,
  }
}

/** 拉取范围：版本号大于客户端持有值的，加上这次推送里输掉的那些。 */
function pullCondition(
  versionColumn: Parameters<typeof gt>[0],
  idColumn: Parameters<typeof inArray>[0],
  clientVersion: number,
  staleIds: readonly string[],
): SQL | undefined {
  const fresh = gt(versionColumn, clientVersion)
  return staleIds.length ? or(fresh, inArray(idColumn, [...staleIds])) : fresh
}

async function loadVersionCounter(tx: Transaction, userId: string): Promise<VersionCounter> {
  await tx
    .insert(schema.user_sync_state)
    .values({ user_id: userId, version: 0 })
    .onConflictDoNothing()
  // 行锁让同一用户的并发同步串行，版本号因此不会被两个请求分到同一个值。
  const [state] = await tx
    .select({ version: schema.user_sync_state.version })
    .from(schema.user_sync_state)
    .where(eq(schema.user_sync_state.user_id, userId))
    .for('update')
  return new VersionCounter(state?.version ?? 0)
}

async function mergeTemplates(
  tx: Transaction,
  userId: string,
  changes: readonly SyncTemplateChange[],
  version: VersionCounter,
): Promise<string[]> {
  const rows = changes.length
    ? await tx
        .select()
        .from(schema.user_templates)
        .where(
          and(
            eq(schema.user_templates.user_id, userId),
            inArray(
              schema.user_templates.id,
              changes.map((change) => change.id),
            ),
          ),
        )
    : []
  return mergeChanges(changes, metaById(rows), version, {
    async write(change, allocated, lastUsedAt) {
      const values = isSyncTombstone(change)
        ? {
            user_id: userId,
            id: change.id,
            updated_at: change.updatedAt,
            version: allocated,
            deleted_at: change.deletedAt,
            last_used_at: null,
            name: null,
            prompt: null,
            asset_ids: null,
            params: null,
            created_at: null,
          }
        : {
            user_id: userId,
            id: change.id,
            updated_at: change.updatedAt,
            version: allocated,
            deleted_at: null,
            last_used_at: lastUsedAt,
            name: change.name,
            prompt: change.prompt,
            asset_ids: [...change.assetIds],
            params: change.params,
            created_at: change.createdAt,
          }
      await tx
        .insert(schema.user_templates)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.user_templates.user_id, schema.user_templates.id],
          set: values,
        })
    },
    async touch(id, allocated, lastUsedAt) {
      await tx
        .update(schema.user_templates)
        .set({ last_used_at: lastUsedAt, version: allocated })
        .where(and(eq(schema.user_templates.user_id, userId), eq(schema.user_templates.id, id)))
    },
  })
}

async function mergeAssets(
  tx: Transaction,
  userId: string,
  changes: readonly SyncAssetChange[],
  version: VersionCounter,
): Promise<string[]> {
  const rows = changes.length
    ? await tx
        .select()
        .from(schema.user_assets)
        .where(
          and(
            eq(schema.user_assets.user_id, userId),
            inArray(
              schema.user_assets.id,
              changes.map((change) => change.id),
            ),
          ),
        )
    : []
  return mergeChanges(changes, metaById(rows), version, {
    async write(change, allocated, lastUsedAt) {
      const values = isSyncTombstone(change)
        ? {
            user_id: userId,
            id: change.id,
            updated_at: change.updatedAt,
            version: allocated,
            deleted_at: change.deletedAt,
            last_used_at: null,
            name: null,
            image_id: null,
            created_at: null,
          }
        : {
            user_id: userId,
            id: change.id,
            updated_at: change.updatedAt,
            version: allocated,
            deleted_at: null,
            last_used_at: lastUsedAt,
            name: change.name,
            image_id: change.imageId,
            created_at: change.createdAt,
          }
      await tx
        .insert(schema.user_assets)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.user_assets.user_id, schema.user_assets.id],
          set: values,
        })
    },
    async touch(id, allocated, lastUsedAt) {
      await tx
        .update(schema.user_assets)
        .set({ last_used_at: lastUsedAt, version: allocated })
        .where(and(eq(schema.user_assets.user_id, userId), eq(schema.user_assets.id, id)))
    },
  })
}

async function mergeSettings(
  tx: Transaction,
  userId: string,
  settings: SyncSettingsDocument | null | undefined,
  version: VersionCounter,
): Promise<boolean> {
  if (!settings) return false
  const [existing] = await tx
    .select({ updated_at: schema.user_preferences.updated_at })
    .from(schema.user_preferences)
    .where(eq(schema.user_preferences.user_id, userId))
  if (existing && settings.updatedAt <= existing.updated_at) return true

  const values = {
    user_id: userId,
    document: settings.document,
    updated_at: settings.updatedAt,
    version: version.allocate(),
  }
  await tx
    .insert(schema.user_preferences)
    .values(values)
    .onConflictDoUpdate({ target: schema.user_preferences.user_id, set: values })
  return false
}

export async function synchronize(
  userId: string,
  request: SyncRequestBody,
): Promise<SyncResponseBody> {
  const templates = dedupe(request.templates)
  const assets = dedupe(request.assets)

  return db.transaction(async (tx) => {
    const version = await loadVersionCounter(tx, userId)
    // 客户端版本号高于服务端说明服务端这份被重建过，退化成全量拉取。
    const clientVersion = Math.min(Math.max(request.version, 0), version.value)

    const staleTemplateIds = await mergeTemplates(tx, userId, templates, version)
    const staleAssetIds = await mergeAssets(tx, userId, assets, version)
    const staleSettings = await mergeSettings(tx, userId, request.settings, version)

    if (version.changed) {
      await tx
        .update(schema.user_sync_state)
        .set({ version: version.value })
        .where(eq(schema.user_sync_state.user_id, userId))
    }

    const templateRows = await tx
      .select()
      .from(schema.user_templates)
      .where(
        and(
          eq(schema.user_templates.user_id, userId),
          pullCondition(
            schema.user_templates.version,
            schema.user_templates.id,
            clientVersion,
            staleTemplateIds,
          ),
        ),
      )
      .orderBy(asc(schema.user_templates.version))
    const assetRows = await tx
      .select()
      .from(schema.user_assets)
      .where(
        and(
          eq(schema.user_assets.user_id, userId),
          pullCondition(
            schema.user_assets.version,
            schema.user_assets.id,
            clientVersion,
            staleAssetIds,
          ),
        ),
      )
      .orderBy(asc(schema.user_assets.version))
    const [settingsRow] = await tx
      .select()
      .from(schema.user_preferences)
      .where(eq(schema.user_preferences.user_id, userId))

    return {
      version: version.value,
      templates: templateRows.map(templateChange),
      assets: assetRows.map(assetChange),
      settings:
        settingsRow && (settingsRow.version > clientVersion || staleSettings)
          ? { updatedAt: settingsRow.updated_at, document: settingsRow.document }
          : null,
      rejected: [],
    }
  })
}
