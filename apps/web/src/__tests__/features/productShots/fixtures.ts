import type { MatteResponse } from '@image-playground/shared'
import type { ProductShotJob } from '../../../features/productShots/types'

const ROUNDS = 40

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 一次点击要串起接口、抠图与 IndexedDB 落盘，微任务刷一轮不够。 */
export async function settleUntil(
  done: () => boolean,
  tick: () => Promise<void> = macrotask,
): Promise<void> {
  for (let round = 0; round < ROUNDS && !done(); round++) await tick()
}

export function settle(tick?: () => Promise<void>): Promise<void> {
  return settleUntil(() => false, tick)
}

export function browserMatte(alpha = new Uint8ClampedArray(4)) {
  return { alpha, width: 2, height: 2, backend: 'wasm-u2netp', elapsedMs: 3200 }
}

/** 全白 alpha 的外接框是整张图，跟一个小小的产品框几乎不重叠。 */
export function matteCoveringEverything() {
  return browserMatte(new Uint8ClampedArray([255, 255, 255, 255]))
}

export function serverMatteResponse(overrides: Partial<MatteResponse> = {}): MatteResponse {
  return {
    alpha: 'data:image/png;base64,SERVER-ALPHA',
    backend: 'cloudflare-birefnet',
    cached: false,
    ...overrides,
  }
}

/** 服务端抠图默认关着，用例要走服务端那条路就自己打开。 */
export function browserOnlyCapabilities(name: string): boolean {
  return name !== 'matte:server'
}

/** 一条已落盘的任务记录。蒙版给成就绪的：列出历史任务不该启动真实抠图。 */
export function productShotJob(
  id: string,
  name: string,
  updatedAt: number,
  versions = 0,
): ProductShotJob {
  return {
    id,
    name,
    images: [
      {
        imageId: `image-${id}`,
        sourceMatte: {
          status: 'ready',
          backend: 'wasm-u2netp',
          alphaImageId: `alpha-${id}`,
          targetImageId: `image-${id}`,
          previewImageId: `preview-${id}`,
          edited: false,
        },
        versions: Array.from({ length: versions }, (_, index) => ({
          id: `${id}-v${index}`,
          taskId: `task-${id}-${index}`,
          plan: '换背景',
          prompt: '锁住产品',
          masked: true,
          createdAt: updatedAt,
        })),
      },
    ],
    preference: '',
    versionsPerImage: 1,
    createdAt: 1_700_000_000_000,
    updatedAt,
  }
}
