import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getOAuthProviderDefinition } from '../../lib/oauth/registry'
import '../../bootstrap/billing'
import {
  _setPrivateBffOverlayForTesting,
  assertPrivateBffOverlayPresent,
  EMPTY_PRIVATE_BFF_OVERLAY,
  loadPrivateBffOverlay,
} from '../../lib/private-overlay'

const repositoryRoot = resolve(import.meta.dir, '../../../../..')

afterEach(() => {
  _setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
})

describe('built-in billing & identity BFF overlay', () => {
  it('bundles standalone and exposes a clean 404 empty overlay when absent', async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'image-playground-public-build-'))
    try {
      const build = await Bun.build({
        entrypoints: [join(repositoryRoot, 'apps/bff/src/lib/private-overlay.ts')],
        outdir: outputDirectory,
        target: 'bun',
      })
      expect(build.success).toBe(true)
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
    }

    expect(EMPTY_PRIVATE_BFF_OVERLAY.present).toBe(false)
    const response = await EMPTY_PRIVATE_BFF_OVERLAY.routes.handle(
      new Request('http://localhost/private-route'),
    )
    expect(response.status).toBe(404)
  })

  it('starts public test processes on the empty overlay by preload default', async () => {
    // 公开测试库只跑公开迁移；由 bunfig.toml 预加载钉成空实现，显式重置后才加载内置计费模块。
    expect(await loadPrivateBffOverlay()).toBe(EMPTY_PRIVATE_BFF_OVERLAY)
  })

  it('loads the built-in billing and identity module and registers Feishu OAuth when reset', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL ??= 'postgres://postgres:postgres@127.0.0.1:5432/private_overlay_test'
    try {
      _setPrivateBffOverlayForTesting()
      const overlay = await loadPrivateBffOverlay()
      expect(overlay.present).toBe(true)
      expect(getOAuthProviderDefinition('feishu')?.id).toBe('feishu')
      // Reloading the same built-in loader is idempotent and keeps the same provider instance.
      _setPrivateBffOverlayForTesting()
      expect((await loadPrivateBffOverlay()).present).toBe(true)
      // When billing:credits capability is off (default), hooks short-circuit without touching DB tables.
      expect(
        await overlay.taskHooks.reserveTask({
          tx: {} as never,
          taskId: 't1',
          userId: 'u1',
          model: 'gpt-image-2',
          quantity: 1,
          unitMultiplier: 1,
        }),
      ).toEqual({ kind: 'reserved', credits: 0 })
      expect(await overlay.taskHooks.chatPricing('gpt-image-2')).toBeNull()
      expect(await overlay.taskHooks.taskCredits({ taskIds: ['t1'] })).toEqual({})
      expect(await overlay.taskHooks.accountSummary?.({ userId: 'u1', now: Date.now() })).toBeNull()
      expect(
        await overlay.taskHooks.canUnlinkOAuthIdentity?.({
          tx: {} as never,
          userId: 'u1',
          provider: 'feishu',
          subject: 's1',
        }),
      ).toEqual({ allowed: true })
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabaseUrl
    }
  })

  it('rejects a required billing module when absent', () => {
    expect(() =>
      assertPrivateBffOverlayPresent(EMPTY_PRIVATE_BFF_OVERLAY, 'billing:credits'),
    ).toThrow('billing:credits requires the billing BFF module')
  })
})
