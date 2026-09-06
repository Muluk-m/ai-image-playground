// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MatteBackend, MatteRunner, ProductAlpha } from '../../../lib/productMatte'
import {
  eligibleBackends,
  MATTE_BACKENDS,
  ProductMatteError,
  segmentProduct,
} from '../../../lib/productMatte'

function backend(id: string, device: 'webgpu' | 'wasm', timeoutMs = 1_000): MatteBackend {
  return {
    id: id as MatteBackend['id'],
    device,
    modelId: `stub/${id}`,
    dtype: 'fp32',
    inputName: 'input',
    inputSize: 32,
    activation: 'minmax',
    timeoutMs,
  }
}

const CHAIN = [backend('webgpu-birefnet', 'webgpu'), backend('wasm-u2netp', 'wasm')]

const MATTE: ProductAlpha = { alpha: new Uint8ClampedArray([255]), width: 1, height: 1 }

/** `storageBuffers` 是适配器报的 `maxStorageBuffersPerShaderStage`，0 表示压根没有 WebGPU。 */
function stubWebGpu(storageBuffers: number) {
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: storageBuffers
      ? {
          requestAdapter: async () => ({
            limits: { maxStorageBuffersPerShaderStage: storageBuffers },
          }),
        }
      : undefined,
    configurable: true,
  })
}

/** 每一环由 `outcomes` 决定成败；'hang' 表示这一环不返回，用来撞超时。 */
function runner(
  outcomes: Record<string, 'ok' | 'hang' | Error>,
): MatteRunner & { calls: string[] } {
  const calls: string[] = []
  const run = vi.fn(async (target: MatteBackend) => {
    calls.push(target.id)
    const outcome = outcomes[target.id]
    if (outcome === 'ok') return MATTE
    if (outcome === 'hang') return new Promise<ProductAlpha>(() => {})
    throw outcome ?? new Error('未配置')
  })
  return Object.assign(run as MatteRunner, { calls })
}

afterEach(() => {
  stubWebGpu(0)
  vi.useRealTimers()
})

describe('segmentProduct 回落链', () => {
  it('第一环抠出来就不试后面的，并记下后端与耗时', async () => {
    stubWebGpu(16)
    const run = runner({ 'webgpu-birefnet': 'ok' })

    const matte = await segmentProduct('data:image/png;base64,AA', { backends: CHAIN, run })

    expect(matte.backend).toBe('webgpu-birefnet')
    expect(matte.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(Array.from(matte.alpha)).toEqual([255])
    expect(run.calls).toEqual(['webgpu-birefnet'])
  })

  it('前一环失败就往下走，记的是真正跑成的那一环', async () => {
    stubWebGpu(16)
    const run = runner({ 'webgpu-birefnet': new Error('shader 炸了'), 'wasm-u2netp': 'ok' })

    const matte = await segmentProduct('data:image/png;base64,AA', { backends: CHAIN, run })

    expect(matte.backend).toBe('wasm-u2netp')
    expect(run.calls).toEqual(['webgpu-birefnet', 'wasm-u2netp'])
  })

  it('某一环超时只废掉这一环，链条继续往下走', async () => {
    stubWebGpu(16)
    const run = runner({ 'webgpu-birefnet': 'hang', 'wasm-u2netp': 'ok' })

    const matte = await segmentProduct('data:image/png;base64,AA', {
      backends: [backend('webgpu-birefnet', 'webgpu', 5), CHAIN[1]],
      run,
    })

    expect(matte.backend).toBe('wasm-u2netp')
  })

  it('没有 WebGPU 时跳过 GPU 环，直接跑 wasm 环', async () => {
    stubWebGpu(0)
    const run = runner({ 'wasm-u2netp': 'ok' })

    const matte = await segmentProduct('data:image/png;base64,AA', { backends: CHAIN, run })

    expect(run.calls).toEqual(['wasm-u2netp'])
    expect(matte.backend).toBe('wasm-u2netp')
  })

  it('全挂了抛最后一环的原因', async () => {
    stubWebGpu(16)
    const run = runner({
      'webgpu-birefnet': new Error('shader 炸了'),
      'wasm-u2netp': new ProductMatteError('timeout', '慢'),
    })

    const error = await segmentProduct('data:image/png;base64,AA', {
      backends: CHAIN,
      run,
    }).catch((err) => err)

    expect(error).toBeInstanceOf(ProductMatteError)
    expect(error.reason).toBe('timeout')
  })

  it('最后一环超时时抛 timeout', async () => {
    stubWebGpu(0)
    const run = runner({ 'wasm-u2netp': 'hang' })

    const error = await segmentProduct('data:image/png;base64,AA', {
      backends: [backend('wasm-u2netp', 'wasm', 5)],
      run,
    }).catch((err) => err)

    expect(error.reason).toBe('timeout')
  })

  it('一环都跑不了时按 unsupported 失败', async () => {
    stubWebGpu(0)
    const run = runner({})

    const error = await segmentProduct('data:image/png;base64,AA', {
      backends: [backend('webgpu-birefnet', 'webgpu')],
      run,
    }).catch((err) => err)

    expect(error.reason).toBe('unsupported')
    expect(run.calls).toEqual([])
  })
})

describe('内置回落链', () => {
  it('从 GPU BiRefNet 排到 wasm 小模型，且始终留有不依赖 WebGPU 的一环', () => {
    expect(MATTE_BACKENDS.map((item) => item.id)).toEqual([
      'webgpu-birefnet',
      'webgpu-u2netp',
      'wasm-u2netp',
    ])
    expect(MATTE_BACKENDS.some((item) => item.device === 'wasm')).toBe(true)
  })

  it('适配器的 storage buffer 不够时直接把 BiRefNet 环划掉，不去下 114 MB 权重', async () => {
    stubWebGpu(10)

    const chain = await eligibleBackends()

    expect(chain.map((item) => item.id)).toEqual(['webgpu-u2netp', 'wasm-u2netp'])
  })

  it('适配器够格时 BiRefNet 环仍排在最前', async () => {
    stubWebGpu(11)

    const chain = await eligibleBackends()

    expect(chain[0].id).toBe('webgpu-birefnet')
  })

  it('没有 WebGPU 时只剩 wasm 环，抠图仍然可用', async () => {
    stubWebGpu(0)

    const chain = await eligibleBackends()

    expect(chain.map((item) => item.id)).toEqual(['wasm-u2netp'])
  })
})
