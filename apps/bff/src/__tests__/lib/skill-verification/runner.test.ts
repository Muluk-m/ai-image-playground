import { describe, expect, it } from 'bun:test'
import { caseTurn } from '../../../lib/skill-verification/cases'
import { createFakeBff } from '../../../lib/skill-verification/fake-bff'
import { RunnerError, runVerificationCase } from '../../../lib/skill-verification/runner'

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3])

function input(model?: string) {
  return {
    skill: 'look-clean-studio',
    caseId: 'mug',
    run: 2,
    turn: caseTurn('look-clean-studio', {
      id: 'mug',
      prompt: '用 {asset1} 出一张主图',
      inputs: { asset1: ['shared:product-mug.webp'] },
    }),
    images: [{ mime: 'image/png', bytes: PNG }],
    ...(model ? { model } : {}),
  }
}

function options(fetch: (input: string, init?: RequestInit) => Promise<Response>) {
  return {
    baseUrl: 'https://bff.test/',
    deviceId: 'verify-device-1',
    fetch,
    sleep: async () => {},
    settlePolls: 2,
    now: () => new Date('2026-10-02T08:00:00Z'),
  }
}

describe('runVerificationCase', () => {
  it('以出图模式发出 /技能名 与参考图，等轮收尾后取回产出图与实际模型', async () => {
    const bff = createFakeBff()
    const output = await runVerificationCase(options(bff.fetch), input('gpt-image-2.5-sunburst'))
    expect(bff.turns).toHaveLength(1)
    const turn = bff.turns[0] as {
      text: string
      mode: string
      params: unknown
      references: { imageId: string; name: string; dataUrl: string }[]
    }
    expect(turn.text).toBe('/look-clean-studio 用 [image 1] 出一张主图')
    expect(turn.mode).toBe('image')
    expect(turn.params).toEqual({ autoSubmit: true, model: 'gpt-image-2.5-sunburst' })
    expect(turn.references).toEqual([
      {
        imageId: 'verify-1',
        name: 'shared:product-mug.webp',
        dataUrl: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
      },
    ])
    expect(output.run).toEqual({
      case: 'mug',
      run: 2,
      model: 'gpt-image-2.5-sunburst',
      date: '2026-10-02',
    })
    expect(output.image).toEqual({ mime: 'image/png', bytes: PNG })
  })

  it('不钉模型时不带 model，记录里写上游实际解析到的模型', async () => {
    const bff = createFakeBff({ model: 'deploy-default-model' })
    const output = await runVerificationCase(options(bff.fetch), input())
    expect((bff.turns[0] as { params: unknown }).params).toEqual({ autoSubmit: true })
    expect(output.run.model).toBe('deploy-default-model')
  })

  it('智能体没出图时记 no_output，不抛错', async () => {
    const bff = createFakeBff({ outcome: 'no_output' })
    const output = await runVerificationCase(options(bff.fetch), input('m'))
    expect(output.image).toBeNull()
    expect(output.run.error).toBe('no_output')
  })

  it('取回产出图后删掉验证会话，免得混进账号的对话项目', async () => {
    const bff = createFakeBff()
    await runVerificationCase(options(bff.fetch), input('m'))
    const noOutput = createFakeBff({ outcome: 'no_output' })
    await runVerificationCase(options(noOutput.fetch), input('m'))

    expect(bff.deleted).toEqual(['c1'])
    expect(noOutput.deleted).toEqual(['c1'])
  })

  it('清理请求挂住时到点放弃，照常返回结果', async () => {
    const bff = createFakeBff()
    const hanging = async (url: string, init: RequestInit = {}) =>
      init.method === 'DELETE'
        ? new Promise<Response>((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
          )
        : bff.fetch(url, init)
    const output = await runVerificationCase(
      { ...options(hanging), cleanupTimeoutMs: 10 },
      input('m'),
    )
    expect(output.image).toEqual({ mime: 'image/png', bytes: PNG })
  })

  it('假 BFF 删掉会话后再建，不会复用仍在跑的会话 id', async () => {
    const bff = createFakeBff()
    const create = async () =>
      (
        (await (
          await bff.fetch('https://bff.test/api/agent/conversations', { method: 'POST' })
        ).json()) as {
          conversation: { id: string }
        }
      ).conversation.id
    const first = await create()
    const second = await create()
    await bff.fetch(`https://bff.test/api/agent/conversations/${first}`, { method: 'DELETE' })
    expect(await create()).not.toBe(second)
  })

  it('接口报错时抛出带状态码的 RunnerError', async () => {
    const failing = async () => new Response('nope', { status: 401 })
    await expect(runVerificationCase(options(failing), input())).rejects.toThrow(RunnerError)
    await expect(runVerificationCase(options(failing), input())).rejects.toThrow('HTTP 401')
  })
})
