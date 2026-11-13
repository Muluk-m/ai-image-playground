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
    page.meta.description,
    ...(page.intro ?? []).map((block) => ('text' in block ? block.text : '')),
    ...page.sections.flatMap((section) => [
      section.title,
      ...section.blocks.flatMap((block) => ('text' in block ? [block.text] : [])),
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
})
