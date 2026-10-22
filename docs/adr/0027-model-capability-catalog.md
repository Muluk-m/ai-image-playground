# ADR 0027：模型能力目录——带 JSON Schema 的 config.json

状态：已接受（2026-10-22）。关联：设计 Page「Provider / 模型配置驱动设计」、#1445、私有库 #76。

## 背景

每个模型能出多大、哪些比例、几张、几张参考图，散在 channels.json 的能力 token、`image.ts` 的全局档位表、`image-parameters.ts` 的 Gemini 常量、`grok.ts`、`paramCompatibility.ts`、`queue-protocol.ts` 等处。能力 token 只表达「有没有」，表达不了「GPT 只有 1K、Pro 到 4K、Lite 只有 1K」，于是切到 GPT 时界面上仍可能出现 4K，智能体也会把存下的大尺寸原样透传。

仓库里此前没有带 JSON Schema 的配置：channels.json 是 JSON，但靠 `apps/bff/src/lib/channels.ts` 手写的 parse 函数校验。

## 决定

- 能力写进代码里的 `packages/shared/src/model-catalog/config.json`，每个图片模型一条：档位与各比例的真实像素、比例、比例的传法（`ratioVia`：请求参数 / 写进提示词）、档位怎么写进上游请求（`wire`）、张数、参考图、预估耗时、按档位的计价倍率，以及每条能力的出处（`evidence`：实测 / 文档 / 代码 / 待核实）和 `todo`。
- 结构只在 `schema.ts`（TypeBox）定义一次：TS 类型由它推出，`schema.json` 由它生成（`bun run catalog:schema`），测试比对两者。导入目录时按 schema 和语义约束校验，BFF 启动时导入，不合法就起不来。
- 对用户只开放 5 档比例：1:1、3:4、9:16、4:3、16:9。
- 不支持的值界面上不给选；后端用同一个 `resolveImageRequest` 回落到最近的可用值照常出图，不回 422。只有参考图超上限会拒绝。
- 按档位计价：同一模型内积分按官方各档成本比例放大，倍率写在 `pricing.tierMultiplier`；基础单价与启停仍在私有价目表。
- 部署层不变：启用哪些模型仍由 channels.json + env 决定。BFF 侧的一致性测试保证目录与 channels.json、`grok.ts`、`image-parameters.ts` 的现有行为一致。视频暂留在 `VIDEO_MODEL_SUPPORT`。

## 考虑过的方案

- **能力放数据库、后台可改**：能力是模型的事实，改错直接出图失败，应当跟着实测和代码评审走。否决。
- **在 channels.json 里加字段**：channels.json 描述「这台部署连哪些渠道」，同一模型在多个部署里的能力相同，混在一起会复制多份。保留 channels.json 做部署清单。
- **zod / Ajv**：BFF 已在用 TypeBox，它本身产出 JSON Schema，无需第二套校验库。

## 后果

- 第一步只登记事实、不改线上行为；之后依次由 `/api/channels` 下发、前端按目录渲染、后端回落与按档计价、Vertex 接入并删除旧常量。
- GPT、Grok 的档位按现有代码行为填写并标 `todo`，待真实探测后按实际返回像素收敛。
