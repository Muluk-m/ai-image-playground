import raw from './config.json'
import type { ModelSpec } from './schema'
import { parseModelCatalog } from './validate'

/**
 * 模型能力目录（ADR 0027）：每个图片模型支持的档位、比例、张数、参考图和计价倍率。
 *
 * 数据在 config.json，结构在 schema.ts（生成 schema.json）。导入本模块时即校验，不合法直接抛错，
 * BFF 启动会因此失败，而不是带着错的能力上线。
 *
 * 目录只描述模型本身，不描述「这台部署能不能用」：启用哪些模型仍由 channels.json + env 决定，
 * 启停和单价仍在价目表。目前还没有代码读它（PR-2 起由 /api/channels 下发）。
 */
export const MODEL_CATALOG: readonly ModelSpec[] = parseModelCatalog(raw).models

const BY_ID: ReadonlyMap<string, ModelSpec> = new Map(MODEL_CATALOG.map((spec) => [spec.id, spec]))

/** 按 id 查目录；不在目录里的模型返回 undefined，调用方按「能力未知」处理。 */
export function findCatalogModel(id: string): ModelSpec | undefined {
  return BY_ID.get(id)
}

export * from './resolve'
export * from './schema'
export { modelCatalogProblems, parseModelCatalog } from './validate'
