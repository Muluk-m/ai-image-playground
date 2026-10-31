# 0028 GPT 双通道：OpenAI 直连 + sub2api

状态：已实现（分支 `feat/gpt-dual-route`，基于 #1604；整个需求一个 PR 上线）。

## 背景

`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` 原来只走 sub2api（`UPSTREAM_BASE_URL`）。sub2api 的
Codex 图片路径丢弃 size 与 quality，一律出约 1.57MP 一档、单张约 40 秒；比例只能写进提示词，多张靠
BFF 拆成多个单图任务。OpenAI 组织是 Tier 1（每模型 20 张/分钟），直连每月预算约 200 美元。

## 决策（Nain 2026-10-31 确认）

- **两条通道共用 `openai-compat` provider，发送前按通道适配参数**（`apps/bff/src/lib/upstream.ts`
  `adaptGptRequest`）：
  - sub2api：把构图句写进提示词（`buildAspectInstruction`，已有就不重复）；n 照旧 fan-out。
  - 直连：发原生 size / quality / n；提交时钉上的防改写前缀与构图句用 `unshapeQueuePrompt` 剥掉；
    `auto` 画质改发 `medium`（auto 可能出高画质，成本没有上限）。
  - 防改写前缀仍由创作页开关与智能体在提交时加；构图句在直连开着时由服务端在 sub2api 这一侧补
    （前端看到 `size` 能力后不再写）。
- **直连只上 flare 与 sunburst**（`packages/shared/src/gpt-direct.ts` `GPT_DIRECT_MODELS`）。
- **选路**（`apps/bff/src/lib/upstream/gpt-routing.ts`）：会员默认直连；直连满了（每分钟张数、在途数、
  429 冷却）、超了月预算或不可用，立刻走 sub2api，不排队。非会员默认 sub2api，sub2api 熔断
  （本进程连续 5 次服务端失败，熔断 60 秒）才借直连。2K/4K/高画质的请求只可能来自会员，按会员处理。
- **换路一次**：一条路发出请求后超过单路时限（直连 150 秒、sub2api 240 秒）没结果，或明确不可用
  （429、5xx、连接中断）时换另一条路重试一次，两路共用 15 分钟硬截止，剩余不足 60 秒不换。
  非会员只在 sub2api 超时时借直连，sub2api 报错计入熔断。换不过去时不掐断原请求。sub2api 异步任务
  一旦受理就不换路（交给轮询与对账）。用户取消、部分出图、参数错不换路。
- **会员档位**：非会员只有 1K、非高画质；2K、4K、高画质只开给会员。提交时非会员越档静默收到 1K
  （按原比例缩放、宽高取 16 的倍数），高画质改 medium。智能体、阶段授权、批量执行、自动提交、
  灵感套用一律按基础档（授权与报价按倍率 1 冻结），会员档位只在创作页直接提交时生效。
- **定价**：按档位与画质的积分倍率（`gptImageRateMultiplier`，以 1K medium 为 1）：
  1K 1/1/4、2K 1/2/8、4K 1/2/8（low/medium/high）。依据 2026-10-31 直连实测输出 token：
  1K 196/439/1756、2K 397/892/3568、4K(3840x2160) 371/865/3336，两个模型相同。低画质不打折。
  会员高档请求落到 sub2api 只出基础档，结果标 `gpt_route.degraded`，结算倍率按 1，差额退回。
- **预算**（`apps/bff/src/lib/upstream/gpt-budget.ts`）：每条直连请求按上游回报的 usage 折算成本写
  `gpt_direct_usage`（拿不到 usage 时按档位估算并标 `estimated`；明确 HTTP 错误不计）。台北时间自然月
  累计 + 本单预估超过「月预算 × 封顶比例（默认 100%）」就不再选直连。用到 80% 发运维告警（`gpt-budget`）。
  失败退款照旧全额退积分，直连已花的成本由平台承担。
- **限流**：沿用 #1604 调度器。直连每模型 16 张/分钟、合计在途 8、429 冷却 60 秒；sub2api 每个环境
  在途 8（默认值从 0 改为 8）。
- **密钥**：直连用 channels.json 里 openai-images 的 `OPENAI_API_KEY`，另加开关 `GPT_DIRECT_ENABLED`
  （正式站这把 key 曾是占位值，没有开关就分不出来）与可选 `OPENAI_ORG_ID`。sub2api 仍用 `UPSTREAM_*`，
  Vertex 用自己的。直连没开时服务端不对外声明这两个模型的 `size` 能力、一律收基础档，行为与直连上线前一致。

## 实测（2026-10-31，真 key，共约 0.6 美元）

- 尺寸约束：宽高为 16 的倍数、最长边 ≤3840、长宽比 ≤3:1、像素 655360–8294400。
- 直连单张 9–33 秒（高画质偏慢）；flare 与 sunburst 的 token 用量一致。

## 迁移

预算表 `gpt_direct_usage` 并进 #1604 尚未在任何库执行过的 `0080_upstream_scheduler`（测试库与生产库都只到
0078），不另起编号。CLI 分支也占了 0080（`0080_cli_scopes`，且丢了 `0079_cli_device_oauth` 的 journal
条目），谁后合谁改号。

## 上线步骤

1. 合并后默认关闭（`GPT_DIRECT_ENABLED` 为空），只多了 sub2api 在途 8 的本地限流。
2. 测试环境先开：配真 `OPENAI_API_KEY`、`GPT_DIRECT_ENABLED=true`，会员与非会员各走一遍。
3. 正式站换真 key 并打开开关。
