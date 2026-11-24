// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CliConnectionsSection from '../../../features/cli/CliConnectionsSection'
import {
  connectionCapabilities,
  parseCliUserAgent,
  shortConnectionId,
} from '../../../features/cli/cliConnectionMeta'
import { setLocale } from '../../../i18n'

describe('cliConnectionMeta', () => {
  it('parses muvloom-cli user agents into readable version and platform labels', () => {
    expect(parseCliUserAgent('muvloom-cli/0.2.7 (darwin/arm64)')).toEqual({
      version: 'v0.2.7',
      platform: 'macOS · Apple Silicon',
    })
    expect(parseCliUserAgent('muvloom-cli/0.2.7 (windows/amd64)')).toEqual({
      version: 'v0.2.7',
      platform: 'Windows · x64',
    })
    expect(parseCliUserAgent('muvloom-cli/dev (linux/arm64)')).toEqual({
      version: 'dev',
      platform: 'Linux · ARM64',
    })
    expect(parseCliUserAgent('curl/8.7.1')).toEqual({ version: null, platform: null })
    expect(parseCliUserAgent(null)).toEqual({ version: null, platform: null })
  })

  it('derives short connection fingerprints and semantic capability tags', () => {
    expect(shortConnectionId('8f2a1c90-1234-4567-89ab-cdef01234567')).toBe('#8f2a1c')
    expect(connectionCapabilities(['images:read', 'images:write', 'media:write'])).toEqual([
      'generate',
      'reference',
      'jobs',
    ])
    expect(connectionCapabilities(['media:read'])).toEqual(['jobs'])
    expect(connectionCapabilities(['images:read'])).toEqual(['jobs'])
    expect(connectionCapabilities(undefined)).toEqual([])
  })
})

describe('CliConnectionsSection', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    setLocale('zh-CN')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    vi.unstubAllGlobals()
  })

  it('renders rich connection metadata in standalone mode including version, platform, short id, job count, expiry, and capabilities', async () => {
    const now = Date.now()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          connections: [
            {
              id: '8f2a1c90-1234-4567-89ab-cdef01234567',
              client_name: 'Muvloom CLI',
              created_at: now - 3 * 24 * 60 * 60 * 1000,
              last_used_at: now - 2 * 60 * 60 * 1000,
              expires_at: now + 20 * 24 * 60 * 60 * 1000,
              scopes: ['images:read', 'images:write', 'media:read', 'media:write'],
              user_agent: 'muvloom-cli/0.2.7 (darwin/arm64)',
              job_count: 12,
            },
            {
              id: 'a1b2c3d4-5678-4567-89ab-cdef01234567',
              client_name: 'Muvloom CLI',
              created_at: now - 20 * 24 * 60 * 60 * 1000,
              last_used_at: null,
              expires_at: now + 3 * 24 * 60 * 60 * 1000,
              scopes: ['images:read'],
              user_agent: null,
              job_count: 0,
            },
          ],
        }),
      ),
    )

    await act(async () => {
      root.render(<CliConnectionsSection standalone />)
    })

    const text = host.textContent ?? ''
    expect(text).toContain('已连接的插件')
    expect(text).toContain('2')
    expect(text).toContain('v0.2.7')
    expect(text).toContain('macOS · Apple Silicon')
    expect(text).toContain('#8f2a1c')
    expect(text).toContain('12 次生成')
    expect(text).toContain('生成图像')
    expect(text).toContain('参考图编辑')
    expect(text).toContain('查询与下载')
    expect(text).toContain('#a1b2c3')
    expect(text).toContain('尚未使用')
    expect(text).toContain('0 次生成')
    expect(text).toContain('有效至')
  })

  it('stays backwards-compatible with legacy connection payloads lacking optional metadata', async () => {
    const now = Date.now()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          connections: [
            {
              id: 'legacy-123456',
              client_name: 'Muvloom CLI',
              created_at: now - 1000,
              last_used_at: now - 1000,
            },
          ],
        }),
      ),
    )

    await act(async () => {
      root.render(<CliConnectionsSection />)
    })

    const text = host.textContent ?? ''
    expect(text).toContain('Muvloom CLI')
    expect(text).toContain('#legacy')
    expect(text).toContain('最近使用')
    expect(text).not.toContain('次生成')
    expect(text).not.toContain('有效至')
  })
})
