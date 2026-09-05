// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductMatteError, segmentProduct } from '../../../lib/productMatte'

const state = vi.hoisted(() => ({
  moduleLoads: 0,
  segment: null as null | (() => Promise<{ width: number; height: number; data: Uint8Array }>),
}))

vi.mock('@huggingface/transformers', () => {
  state.moduleLoads++

  const tensor = {
    sigmoid: () => tensor,
    mul: () => tensor,
    to: () => tensor,
  }

  return {
    AutoModel: { from_pretrained: async () => async () => ({ output_image: [tensor] }) },
    AutoProcessor: { from_pretrained: async () => async () => ({ pixel_values: tensor }) },
    RawImage: {
      fromURL: async () => ({ width: 2, height: 2 }),
      fromTensor: () => ({ resize: async () => state.segment?.() }),
    },
  }
})

function stubWebGpu(present: boolean) {
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: present ? {} : undefined,
    configurable: true,
  })
}

beforeEach(() => {
  state.segment = async () => ({ width: 2, height: 2, data: new Uint8Array([0, 90, 200, 255]) })
})

afterEach(() => {
  stubWebGpu(false)
})

describe('segmentProduct', () => {
  it('模块加载本身不把分割模型拉进来', () => {
    expect(state.moduleLoads).toBe(0)
  })

  it('缺少 WebGPU 时直接失败，不下载模型', async () => {
    stubWebGpu(false)

    await expect(segmentProduct('data:image/png;base64,AA')).rejects.toMatchObject({
      reason: 'unsupported',
    })
    expect(state.moduleLoads).toBe(0)
  })

  it('首次调用才动态加载模型，并返回与图片同尺寸的 alpha', async () => {
    stubWebGpu(true)

    const matte = await segmentProduct('data:image/png;base64,AA')

    expect(state.moduleLoads).toBe(1)
    expect(matte.width).toBe(2)
    expect(matte.height).toBe(2)
    expect(Array.from(matte.alpha)).toEqual([0, 90, 200, 255])
  })

  it('重复调用不重复加载模块', async () => {
    stubWebGpu(true)

    await segmentProduct('data:image/png;base64,AA')

    expect(state.moduleLoads).toBe(1)
  })

  it('超时抛出可识别的失败', async () => {
    stubWebGpu(true)
    state.segment = () => new Promise(() => {})

    const error = await segmentProduct('data:image/png;base64,AA', { timeoutMs: 10 }).catch(
      (err) => err,
    )

    expect(error).toBeInstanceOf(ProductMatteError)
    expect(error.reason).toBe('timeout')
  })

  it('推理异常归一化为 failed', async () => {
    stubWebGpu(true)
    state.segment = async () => {
      throw new Error('boom')
    }

    await expect(segmentProduct('data:image/png;base64,AA')).rejects.toMatchObject({
      reason: 'failed',
    })
  })
})
