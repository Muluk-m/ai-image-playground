import { type Static, type TSchema, Type } from 'typebox'

/**
 * 模型能力目录 config.json 的结构定义，也是 schema.json 的唯一来源。
 *
 * 改结构只改这里，然后跑 `bun run catalog:schema`（packages/shared）重新生成 schema.json；
 * 测试会比对两者，不一致就失败。TS 类型由 `Static` 从同一份定义推出，所以类型、schema.json、
 * 运行时校验三者不会各说各话。
 */

/** 分辨率档位，从小到大。回落时按这个顺序找最近的一档。 */
export const IMAGE_TIERS = ['512', '1K', '2K', '4K'] as const
export type ImageTier = (typeof IMAGE_TIERS)[number]

/** 对用户开放的比例：产品定为现有 5 档，不开放 1:4、4:1、1:8 这类长条比例。 */
export const CATALOG_RATIOS = ['1:1', '3:4', '9:16', '4:3', '16:9'] as const
export type CatalogRatio = (typeof CATALOG_RATIOS)[number]

const strict = { additionalProperties: false } as const

const Tier = Type.Union([
  Type.Literal('512'),
  Type.Literal('1K'),
  Type.Literal('2K'),
  Type.Literal('4K'),
])

const Ratio = Type.Union([
  Type.Literal('1:1'),
  Type.Literal('3:4'),
  Type.Literal('9:16'),
  Type.Literal('4:3'),
  Type.Literal('16:9'),
])

/** 按档位取值的表；只写有的档位。 */
function tierMap<T extends TSchema>(value: T) {
  return Type.Object(
    {
      '512': Type.Optional(value),
      '1K': Type.Optional(value),
      '2K': Type.Optional(value),
      '4K': Type.Optional(value),
    },
    strict,
  )
}

const Pixels = Type.String({ pattern: '^[1-9][0-9]*x[1-9][0-9]*$', description: '宽x高' })

const Evidence = Type.Object(
  {
    source: Type.Union(
      [
        Type.Literal('probe'),
        Type.Literal('docs'),
        Type.Literal('code'),
        Type.Literal('unverified'),
      ],
      { description: 'probe = 实测；docs = 官方文档；code = 现有代码行为；unverified = 拿不准' },
    ),
    at: Type.Optional(
      Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '实测或查阅日期' }),
    ),
    note: Type.Optional(Type.String({ description: '文档地址、代码位置或一句说明' })),
  },
  strict,
)

const TierSpec = Type.Object(
  {
    id: Tier,
    /** 这个档位下各比例的真实输出像素。缺的比例表示像素未知，不表示不支持。 */
    pixels: Type.Object(
      {
        '1:1': Type.Optional(Pixels),
        '3:4': Type.Optional(Pixels),
        '9:16': Type.Optional(Pixels),
        '4:3': Type.Optional(Pixels),
        '16:9': Type.Optional(Pixels),
      },
      strict,
    ),
  },
  strict,
)

const PixelsWire = Type.Object(
  {
    kind: Type.Literal('pixels'),
    multiple: Type.Integer({ minimum: 1 }),
    maxEdge: Type.Integer({ minimum: 1 }),
    minPixels: Type.Integer({ minimum: 1 }),
    maxPixels: Type.Integer({ minimum: 1 }),
    maxAspect: Type.Number({ minimum: 1 }),
  },
  { ...strict, description: '发 `宽x高`（OpenAI Images 的 size），像素取自 tiers[].pixels' },
)

const TierTokenWire = Type.Object(
  {
    kind: Type.Literal('tier-token'),
    /** 档位写进上游请求的哪个字段，如 Gemini 的 `imageConfig.imageSize`、Grok 的 `resolution`。 */
    param: Type.String({ minLength: 1 }),
    tokens: tierMap(Type.String({ minLength: 1 })),
  },
  { ...strict, description: '发档位 token（Gemini `4K`、Grok `2k`）' },
)

const ImageCapabilities = Type.Object(
  {
    operations: Type.Array(
      Type.Union([Type.Literal('generate'), Type.Literal('edit'), Type.Literal('mask_edit')]),
      { minItems: 1, uniqueItems: true },
    ),
    /** 支持的档位，从小到大。没列的档位就是不支持，界面不展示。 */
    tiers: Type.Array(TierSpec, { minItems: 1 }),
    ratios: Type.Array(Ratio, { minItems: 1, uniqueItems: true }),
    /**
     * 比例怎么传给上游：`param` = 请求参数（size 像素或 aspect_ratio）；`prompt` = 把构图比例写进
     * 提示词（buildAspectInstruction）。两者都写表示参数和提示词同时带。
     */
    ratioVia: Type.Array(Type.Union([Type.Literal('param'), Type.Literal('prompt')]), {
      minItems: 1,
      uniqueItems: true,
    }),
    /** 能否不指定比例，交给模型决定。 */
    autoRatio: Type.Boolean(),
    defaultTier: Tier,
    wire: Type.Union([PixelsWire, TierTokenWire]),
    count: Type.Object(
      {
        /** 一次最多几张。 */
        max: Type.Integer({ minimum: 1 }),
        /** true = 一条任务带 n（渠道能力 'n'）；false = 拆成 n 条任务，每条 1 张。 */
        singleTask: Type.Boolean(),
      },
      strict,
    ),
    /** 参考图上限；0 = 不接参考图。 */
    references: Type.Object({ max: Type.Integer({ minimum: 0 }) }, strict),
    quality: Type.Optional(
      Type.Object(
        { values: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }) },
        strict,
      ),
    ),
    thinking: Type.Optional(
      Type.Object(
        { levels: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }) },
        strict,
      ),
    ),
    /** 各档位典型单张耗时（秒），只用于提示。 */
    etaSeconds: Type.Optional(tierMap(Type.Number({ exclusiveMinimum: 0 }))),
  },
  strict,
)

const ModelSpec = Type.Object(
  {
    /** 对外 id：channels.json 的模型 id，也是价目表 billing_model_prices.model 的主键。 */
    id: Type.String({ minLength: 1 }),
    vendor: Type.Union([
      Type.Literal('openai'),
      Type.Literal('xai'),
      Type.Literal('google'),
      Type.Literal('agnes'),
    ]),
    /** 取代各处按 id 前缀猜厂商的写法。 */
    family: Type.Union([
      Type.Literal('gpt'),
      Type.Literal('grok'),
      Type.Literal('gemini'),
      Type.Literal('agnes'),
    ]),
    media: Type.Literal('image'),
    image: ImageCapabilities,
    pricing: Type.Object(
      {
        unit: Type.Literal('image'),
        /** 按档位计价的倍率，乘在价目表单价上；缺省 = 各档同价。 */
        tierMultiplier: Type.Optional(tierMap(Type.Number({ exclusiveMinimum: 0 }))),
      },
      strict,
    ),
    evidence: Type.Object(
      {
        tiers: Evidence,
        ratios: Evidence,
        count: Evidence,
        references: Evidence,
        etaSeconds: Type.Optional(Evidence),
        pricing: Type.Optional(Evidence),
      },
      strict,
    ),
    /** 还没核实、要回头改的事项。evidence 里有 unverified 时必须写。 */
    todo: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  },
  strict,
)

export const ModelCatalogSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    version: Type.Literal(1),
    models: Type.Array(ModelSpec, { minItems: 1 }),
  },
  {
    ...strict,
    $id: 'https://muvloom.online/schemas/model-catalog.schema.json',
    title: '模型能力目录',
    description:
      '每个图片模型支持的档位、比例、张数、参考图和计价倍率。由 schema.ts 生成，不要手改。',
  },
)

export type ModelCatalogConfig = Static<typeof ModelCatalogSchema>
export type ModelSpec = ModelCatalogConfig['models'][number]
export type ImageCapabilities = ModelSpec['image']
export type TierSpec = ImageCapabilities['tiers'][number]
export type ImageWire = ImageCapabilities['wire']
export type Evidence = ModelSpec['evidence']['tiers']
export type Pixels = string

/** 生成 schema.json 的内容（稳定的 2 空格缩进 + 结尾换行）。 */
export function renderModelCatalogSchema(): string {
  return `${JSON.stringify(ModelCatalogSchema, null, 2)}\n`
}
