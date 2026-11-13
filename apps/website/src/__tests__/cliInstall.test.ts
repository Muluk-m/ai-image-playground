import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { editions } from '../catalog'

const installDir = resolve(import.meta.dirname, '../../../../cli-go/install')
const sha256 = (name: string) =>
  createHash('sha256')
    .update(readFileSync(resolve(installDir, name)))
    .digest('hex')

describe('官网指南里的 CLI 安装命令', () => {
  it.each(
    Object.entries(editions),
  )('%s 带着真实安装脚本的 SHA-256 与指南版本', (_locale, guide) => {
    const prompts = guide.groups
      .flatMap((group) => group.pages)
      .flatMap((page) => page.sections)
      .flatMap((section) => section.blocks)
      .flatMap((block) => (block.type === 'prompt' ? [block.text] : []))
      .join('\n')
    expect(prompts).toContain(`[ "$actual" = "${sha256('install.sh')}" ]`)
    expect(prompts).toContain(`-ne "${sha256('install.ps1')}"`)
    expect(prompts).toMatch(/\/cli\/install\.sh\?v=[0-9a-f]{10}"/)
  })
})
