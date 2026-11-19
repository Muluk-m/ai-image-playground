import { describe, expect, it } from 'vitest'
import {
  CLI_MIN_VERSION,
  INSTALL_PS1_SHA256,
  INSTALL_SH_SHA256,
  installScriptCommands,
} from '../../../features/cli/connectAgents'
import { guideEn } from '../../../features/guide/content/en'
import { plugins as pluginsZh } from '../../../features/guide/content/zh/part3'
import type { GuidePage } from '../../../features/guide/model'

const unix = installScriptCommands('unix', 'https://muvloom.online').join('\n')
const windows = installScriptCommands('windows', 'https://muvloom.online').join('\n')

function pluginsEn(): GuidePage {
  const page = guideEn.groups.flatMap((group) => group.pages).find((item) => item.id === 'cli')
  if (!page) throw new Error('missing English plugins/cli page')
  return page
}

function promptTexts(page: GuidePage): string[] {
  return page.sections.flatMap((section) =>
    section.blocks.flatMap((block) => (block.type === 'prompt' ? [block.text] : [])),
  )
}

function pageText(page: GuidePage): string {
  return [
    page.title,
    page.summary,
    page.meta.description,
    ...(page.intro ?? []).map((block) => ('text' in block ? block.text : '')),
    ...page.sections.flatMap((section) => [
      section.title,
      ...section.blocks.flatMap((block) => {
        if ('text' in block) return [block.text]
        if (block.type === 'list' || block.type === 'steps') return block.items
        if (block.type === 'table') return [...block.head, ...block.rows.flat()]
        if (block.type === 'faq') return block.items.flatMap((item) => [item.q, item.a])
        return []
      }),
    ]),
  ].join('\n')
}

describe('使用指南里的 CLI 安装命令与接入页一致', () => {
  it.each([
    ['en', pluginsEn()],
    ['zh', pluginsZh],
  ] as const)('%s 使用同域校验与最低版本，不再管道进 shell', (_lang, page) => {
    expect(promptTexts(page)).toEqual(expect.arrayContaining([unix, windows]))
    const text = pageText(page)
    expect(text).toContain(`MUVLOOM_MIN_VERSION=${CLI_MIN_VERSION}`)
    expect(text).toContain(INSTALL_SH_SHA256)
    expect(text).toContain(INSTALL_PS1_SHA256)
    expect(text).not.toContain('MUVLOOM_VERSION=0.2.4')
    expect(text).not.toContain('940f1faf')
    expect(text).not.toMatch(/curl .*\| sh/)
    expect(text).not.toMatch(/irm .*\| iex/)
  })

  it.each([
    ['en', pluginsEn()],
    ['zh', pluginsZh],
  ] as const)('%s 保留 WorkBuddy 视频教程，并覆盖所有客户端、CLI 命令、退出码与 FAQ', (_lang, page) => {
    const videos = (page.intro ?? []).filter((block) => block.type === 'video')
    expect(videos).toHaveLength(1)
    expect(videos[0]?.src).toContain('workbuddy-tutorial')

    const text = pageText(page)
    expect(text).toContain('WorkBuddy')
    expect(text).toMatch(/豆包工作|Doubao Work/)
    expect(text).toContain('Claude Code')
    expect(text).toContain('Codex')
    expect(text).toContain('muvloom skill install --host claude-code')
    expect(text).toContain('muvloom skill install --host codex')
    expect(text).toContain('muvloom images create')
    expect(text).toContain('muvloom images validate')
    expect(text).toContain('muvloom jobs wait')
    expect(text).toContain('SERVICE_MISMATCH')
    expect(text).toContain('PLAN_REQUIRED')
    expect(text).toContain('wait_timed_out')
  })
})
