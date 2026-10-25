import type { ImageCapabilities, ModelSpec } from './schema'

/**
 * `/api/channels` 随模型下发的图片能力：目录条目去掉 `wire`。
 *
 * `wire` 是「怎么写进上游请求」，只有 BFF 用；前端要的「有几档」「哪些比例」都在其余字段里
 * （只有一档时 tiers 只有一项）。字段与 config.json 同名同义，前端不需要另一套词表。
 */
export type PublishedImageCapabilities = Omit<ImageCapabilities, 'wire'>

export interface PublishedModelCapabilities {
  readonly family: ModelSpec['family']
  readonly image: PublishedImageCapabilities
}

/** 目录条目 → 下发形态。返回新对象，调用方改它不会污染目录。 */
export function publishModelCapabilities(spec: ModelSpec): PublishedModelCapabilities {
  const { wire: _wire, ...image } = structuredClone(spec.image)
  return { family: spec.family, image }
}
