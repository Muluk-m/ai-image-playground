import { describe, expect, it } from 'bun:test'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { buildStoryboardPrompt } = await import('../../lib/storyboard')

const REQUEST = {
  idea: '一支讲通勤咖啡的短片',
  shots: 4,
  secondsPerShot: 8,
  aspectRatio: '9:16',
} as const

describe('buildStoryboardPrompt', () => {
  it('carries every request parameter into the prompt', () => {
    const prompt = buildStoryboardPrompt(REQUEST)

    expect(prompt).toContain('一支讲通勤咖啡的短片')
    expect(prompt).toContain('恰好 4 个镜头')
    expect(prompt).toContain('8 秒')
    expect(prompt).toContain('9:16')
  })

  it('names the style only when the caller asked for one', () => {
    expect(buildStoryboardPrompt({ ...REQUEST, style: '胶片颗粒' })).toContain('胶片颗粒')
    expect(buildStoryboardPrompt(REQUEST)).not.toContain('风格要求')
  })

  it('mentions the reference image only when one is attached', () => {
    expect(
      buildStoryboardPrompt({ ...REQUEST, referenceImage: 'data:image/png;base64,AA==' }),
    ).toContain('参考图')
    expect(buildStoryboardPrompt(REQUEST)).not.toContain('参考图')
  })

  /** 分镜要能导出到别的工具用，所以每条提示词都必须离开这份 JSON 也成立。 */
  it('asks for strict JSON whose prompts a stranger could paste elsewhere', () => {
    const prompt = buildStoryboardPrompt(REQUEST)

    expect(prompt).toContain('只输出一个 JSON 对象')
    expect(prompt).toContain('imagePrompt')
    expect(prompt).toContain('videoPrompt')
    expect(prompt).toContain('没看过这份分镜')
  })
})
