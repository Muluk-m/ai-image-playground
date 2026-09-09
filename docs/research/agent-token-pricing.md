# 智能体对话按 token 扣积分：单价建议

调研日期：2026-09-08。只读调研，未改动任何计费代码。

汇率口径：本文所有美元换算按 **USD/CNY = 7.1**，出现 `$` 处均为按此汇率折算或引用的官方美元标价。

---

## 一、积分与钱的兑换关系

### 1.1 套餐（唯一的定价锚点）

数据来自 `private/apps/bff/billing/migrations/0000_billing.sql`：

| 套餐 | 每月积分 | 1 个月 | 3 个月 | 12 个月 | 来源行 |
| --- | --- | --- | --- | --- | --- |
| starter 入门 | 66,000 | ¥49 | ¥147 | ¥588 | `0000_billing.sql:100`、`:106-108` |
| standard 标准 | 220,000 | ¥129 | ¥387 | ¥1548 | `0000_billing.sql:101`、`:109-111` |
| professional 专业 | 600,000 | ¥299 | ¥897 | ¥3588 | `0000_billing.sql:102`、`:112-114` |

两个事实需要先钉住：

- **价格单位是「分」，货币是人民币。** `billing_plan_prices.original_price_cents`（`private/apps/bff/billing/schema.ts:47`）存分，前端 `formatMoney` 除以 100 后加 `¥` 前缀（`private/apps/web/billing-store.ts:150-152`）。
- **3 / 12 个月没有折扣**，3 个月价 = 月价 ×3，12 个月价 = 月价 ×12（`0000_billing.sql:106-114`）。唯一一次促销是 starter 月付 ¥39，`discount_ends_at = 2026-09-01`（`0000_billing.sql:106`），今天已过期。所以周期长短不改变单位积分价格。
- **没有独立的充值档位表。** 充值只有运营在 Admin 后台手工加积分的入口（`private/apps/admin/UserDetailPanel.tsx:78`、`:458-460` → `/api/private/billing/users/:id/recharge`，服务端 `private/apps/bff/billing/service.ts:518-527`），金额自由填，不存在预设档位，因此无法从充值侧读出第二条兑换率。
- 新用户赠送 2,000 积分（`private/apps/bff/billing/config.ts:3`）。

### 1.2 1 积分 = 多少钱

| 口径 | 计算 | 每积分 | 每 1,000 积分 |
| --- | --- | --- | --- |
| **最贵**（starter） | ¥49 ÷ 66,000 | ¥0.000742 / $0.0001046 | ¥0.742 |
| 中档（standard） | ¥129 ÷ 220,000 | ¥0.000586 / $0.0000826 | ¥0.586 |
| **最便宜**（professional） | ¥299 ÷ 600,000 | ¥0.000498 / $0.0000702 | ¥0.498 |

**区间：1 积分 ≈ ¥0.0005 ~ ¥0.00074（$0.00007 ~ $0.000105）。** 后文一律用「starter 口径 / professional 口径」两端给数。

参考值：新用户 2,000 赠送积分 ≈ ¥1.0 ~ ¥1.5。

### 1.3 现有图片模型的积分单价

来自 `0000_billing.sql:93-97` 与 `private/apps/bff/billing/migrations/0005_grok_imagine_prices.sql:1-4`：

| 模型 | 积分 / 张 | 来源 |
| --- | --- | --- |
| gpt-image-2 | 100 | `0000_billing.sql:94` |
| gemini-3.1-flash-image | 25 | `0000_billing.sql:95` |
| agnes-image-2.1-flash | 100 | `0000_billing.sql:96` |
| grok-imagine-image | 100 | `0005_grok_imagine_prices.sql:2` |
| grok-imagine-image-2.0 | 100 | `0005_grok_imagine_prices.sql:3` |

扣费公式 `required = ceil(credits_per_image × quantity × unitMultiplier)`（`private/apps/bff/billing/service.ts:203`，前端同式 `private/apps/web/billing-store.ts:172`）。视频模型走 `unit = 'second'`，单价即每秒积分（`private/apps/bff/billing/migrations/0006_model_price_unit.sql:1-8`、`schema.ts:20-29`）。

### 1.4 上游官方成本与现有毛利倍数

上游成本（官方定价页，2026-09-08 查）：

| 模型 | 官方单价 | 来源 |
| --- | --- | --- |
| gpt-image-2 | 图像输出 $30 / 1M token；1024² 折合 低 $0.005 / 中 $0.041 / 高 $0.165 每张 | <https://developers.openai.com/api/docs/pricing>（2026-09-08）；每张折算见 <https://costgoat.com/pricing/openai-images>（2026-09-08） |
| gemini-3.1-flash-image | 图像输出 $60 / 1M token；0.5K $0.045 / 1K $0.067 / 2K $0.101 / 4K $0.151 每张 | <https://ai.google.dev/gemini-api/docs/pricing>（2026-09-08） |
| grok-imagine-image-2.0 | $0.04 / 张 | <https://docs.x.ai/developers/models/grok-imagine-image-2.0>（2026-09-08） |
| agnes-image-2.1-flash | 标价 $0.003 / 张，当前 $0 促销 | <https://www.glbgpt.com/hub/agnes-image-2-1-flash-pricing>（2026-09-08） |

毛利倍数 = 积分折算收入 ÷ 上游官方成本：

| 模型 | 积分 | 收入（starter / professional） | 官方成本 | 毛利倍数 |
| --- | --- | --- | --- | --- |
| gpt-image-2（中质量 1024²） | 100 | $0.01046 / $0.00702 | $0.041 | **0.26x / 0.17x** |
| gpt-image-2（低质量 1024²） | 100 | 同上 | $0.005 | 2.09x / 1.40x |
| gemini-3.1-flash-image（1K） | 25 | $0.00261 / $0.00176 | $0.067 | **0.04x / 0.03x** |
| grok-imagine-image-2.0 | 100 | $0.01046 / $0.00702 | $0.04 | **0.26x / 0.18x** |
| agnes-image-2.1-flash | 100 | $0.01046 / $0.00702 | $0.003 | 3.49x / 2.34x |

**这张表是本次调研最重要的发现：按官方定价，现有图片积分单价里只有 agnes（和低质量档的 gpt-image-2）是正毛利，gemini / grok / 中质量 gpt-image-2 全部亏本，最狠的 gemini 只收回成本的 4%。** 也就是说现价不是照官方价定的。

反推：若要维持 agnes 那一档 2.3 ~ 3.5x 的毛利，100 积分模型的上游单位成本上限是 **$0.0030 ~ $0.0045 / 张**——相当于 gpt-image-2 中质量官方价的 7~11%、gemini 1K 官方价的 4.5~6.7%、grok 官方价的 7.5~11%。

这个 5~10% 的区间与 sub2api 一类中转/拼车服务的报价带吻合。**结论：本项目的积分单价是按「中转价（官方价的 5~10%）」定的，不是按官方价定的。后面的 token 单价必须沿用同一条基准，并明确写出这个假设。**

### 1.5 sub2api 是什么

- 项目：`Wei-Shaw/sub2api`，「一站式开源中转服务，让 Claude、OpenAI、Gemini、Grok 订阅统一接入，支持拼车共享」。<https://github.com/Wei-Shaw/sub2api>（2026-09-08）
- 它是**网关/中转层本身**，不是一家报价商：负责鉴权、计费、负载均衡、请求转发，README 里强调 "Precise Billing - Token-level usage tracking and cost calculation"。
- **它转发 OpenAI 模型时是否按官方价：无公开说明。** README 未声明自身加价率或倍率。可确认的只有两点：(1) 其价格目录支持用 JSON patch 覆盖官方定价数据，即加价/打折完全由部署方自行配置；(2) 搜索结果中提到基于 sub2api 搭建的第三方中转对外报价「低至官方价的 7%」，但这是下游服务商的报价，不是 sub2api 自身的规则。
- 另需注意：README 有显著免责声明，称此类用法「可能违反 Anthropic 及其他上游提供商的服务条款」，风险自负。

---

## 二、GPT-6 系列官方 token 定价

来源：<https://developers.openai.com/api/docs/pricing>（原 `https://openai.com/api/pricing` / `https://platform.openai.com/docs/pricing` 已 301 到此），2026-09-08 查。

**GPT-6 系列目前只有一个成员：`gpt-6-astra`，没有 mini / nano 变体。** 它采用 272K token 的断点定价（短上下文 / 长上下文两档）。

| gpt-6-astra 档位 | 输入 / 1M | 缓存输入 / 1M | 输出 / 1M |
| --- | --- | --- | --- |
| Standard（短上下文，≤272K） | $10.00 | $1.00 | $50.00 |
| Standard（长上下文，>272K） | $20.00 | $2.00 | $75.00 |
| Batch / Flex（短） | $5.00 | $0.50 | $25.00 |
| Fast Mode（短） | $20.00 | $2.00 | $100.00 |

由于没有 mini / nano，把同页上适合做对话智能体的更便宜档位一并列出（Standard，短上下文）：

| 模型 | 输入 / 1M | 缓存输入 / 1M | 输出 / 1M |
| --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $1.00 | $50.00 |
| gpt-5.6-sol | $4.00 | $0.40 | $20.00 |
| gpt-5.6-terra | $2.00 | $0.20 | $12.00 |
| **gpt-5.6-luna** | **$0.20** | **$0.02** | **$1.20** |
| gpt-5.4 | $2.50 | $0.25 | $15.00 |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 |
| gpt-5.4-nano | $0.20 | $0.02 | $1.25 |
| gpt-5-mini | $0.25 | $0.025 | $2.00 |
| gpt-5-nano | $0.05 | $0.005 | $0.40 |

缓存输入统一是输入价的 10%。

---

## 三、单价建议

### 3.1 保本线：每 1k token 需要多少积分

保本积分 / 1k token = （美元每 1M 价 ÷ 1000）÷ 每积分美元值。starter 口径系数 9.56、professional 口径系数 14.25。

| 模型 | 输入保本（starter / pro） | 输出保本（starter / pro） | 一轮保本（6k 输入 + 800 输出） |
| --- | --- | --- | --- |
| gpt-6-astra | 96 / 143 | 478 / 712 | **956 / 1424 积分（9.6 ~ 14 张图）** |
| gpt-5.6-terra | 19 / 28 | 115 / 171 | 207 / 308 积分（2 ~ 3 张图） |
| gpt-5.4-mini | 7 / 11 | 43 / 64 | 77 / 115 积分 |
| gpt-5-mini | 2.4 / 3.6 | 19 / 28 | 30 / 44 积分 |
| gpt-5.6-luna | 1.9 / 2.8 | 12 / 17 | **21 / 31 积分（0.2 ~ 0.3 张图）** |
| gpt-6-astra 走 7% 中转 | 6.7 / 10 | 33 / 50 | 67 / 100 积分 |

**硬约束：在现有积分兑换率下，gpt-6-astra 按官方价做对话是不可能的**——单轮保本就要 956 积分，约等于 10 张 gpt-image-2，starter 用户一个月只够聊 69 轮。可行路径只有两条：(a) 智能体锁在 luna / nano 档；(b) 走官方价 5~7% 的中转，与图片走的是同一条路。

### 3.2 三档建议

输入:输出 = 1:5，与 OpenAI 全系列的比例一致。缓存输入按输入价的 1/5 计（官方是 1/10，留一档余量），向上取整到 1。

一轮典型对话 = 输入 6k token + 输出 800 token，消耗 = `6 × 输入单价 + 0.8 × 输出单价`。

| 档 | 输入 / 1k | 缓存输入 / 1k | 输出 / 1k | 一轮消耗 | 相当于 gpt-image-2 | 输出预留上限 |
| --- | --- | --- | --- | --- | --- | --- |
| **A 保守** | 10 | 2 | 50 | **100 积分** | 1.0 张 | 2,000 token（hold 160 积分） |
| **B 对齐图片毛利（推荐）** | 6 | 1 | 30 | **60 积分** | 0.6 张 | 2,000 token（hold 96 积分） |
| **C 激进拉新** | 2 | 1 | 10 | **20 积分** | 0.2 张 | 1,500 token（hold 27 积分） |

各档毛利倍数（收入 ÷ 上游成本，starter 口径 / professional 口径）：

| 档 | 一轮收入 | vs gpt-5.6-luna 官方 | vs gpt-5-mini 官方 | vs gpt-5.4-mini 官方 | vs gpt-6-astra @7% 中转 | vs gpt-6-astra 官方 |
| --- | --- | --- | --- | --- | --- | --- |
| A | $0.01046 / $0.00702 | 4.84x / 3.25x | 3.37x / 2.26x | 1.29x / 0.87x | 1.49x / 1.00x | 0.10x / 0.07x |
| B | $0.00627 / $0.00421 | 2.90x / 1.95x | 2.02x / 1.36x | 0.77x / 0.52x | 0.90x / 0.60x | 0.06x / 0.04x |
| C | $0.00209 / $0.00140 | 0.97x / 0.65x | 0.67x / 0.45x | 0.26x / 0.17x | 0.30x / 0.20x | 0.02x / 0.01x |

（图片侧的参照毛利：agnes 档 3.49x / 2.34x，见 1.4。）

**各档一句话代价：**

- **A 保守（10 / 50）** — 毛利 3.3~4.8x（luna 口径），比图片还厚，连 gpt-6-astra 走 7% 中转都刚好保本。代价：一轮聊天 = 一整张图，用户会本能地少说话，压缩掉的是出图量，等于用对话去反噬主业。
- **B 对齐图片毛利（6 / 30，推荐）** — 毛利 1.95~2.90x（luna 口径），与图片 agnes 档 2.34~3.49x 同量级，一轮 0.6 张图，观感上「聊天比出图便宜」成立。代价：模型必须锁死在 luna / nano 档；一旦想升到 terra 或 astra，必须先把中转倍率压到官方价 5% 以内，否则直接翻负。
- **C 激进拉新（2 / 10）** — 一轮 0.2 张图，用户几乎感觉不到对话在扣钱，转化最好。代价：即便对 luna 官方价也只有 0.65~0.97x，是**贴钱**做的，靠出图利润补贴；必须配轮数上限和模型硬锁，且 luna 一涨价就立刻见血。

### 3.3 用户观感判断

以 B 档、starter 套餐（66,000 积分/月）为例：

- 只聊天：1,100 轮 / 月
- 只出图：660 张 gpt-image-2 / 月
- 混合（每 2 轮对话出 1 张图）：约 500 张图 + 1,000 轮对话，对话占账单 37%

一轮 60 积分 vs 一张图 100 积分，比值 0.6，落在「聊天明显比出图便宜、但不是免费」的区间，是合理的。A 档的 1.0 比值会让用户把对话当成和出图同等重量的消费行为，这在一个以出图为主业的产品里是错的定位。新用户 2,000 赠送积分在 B 档下够 33 轮对话或 20 张图，够走完一次完整体验。

### 3.4 落地时必须先解决的两个实现问题

1. **`billing_model_prices.credits_per_image` 是正整数**（`0000_billing.sql:3`），无法直接表达小数单价。可行做法：注册一个伪模型 `agent-chat`，`credits_per_image` 存输入单价（B 档为 6），提交时 `quantity = 1`、`unitMultiplier = 输入千token数 + 输出千token数 × 5`——`service.ts:203` 的 `ceil(price × quantity × multiplier)` 正好给出目标金额，无需改表结构。

2. **`finalizeTask` 只有「全额扣」和「全额退」两条路**（`private/apps/bff/billing/service.ts:255-323`：`committed = outcome === 'completed'`，成功则整笔 commit，失败则整笔 release），**没有部分退回**。token 计费必须按输出预留上限先 hold（B 档 96 积分），再按实际输出量结算（典型 60 积分），把差额 36 退回。这需要给 `finalizeTask` 增加一个「按实际用量结算、退回余额」的分支，并在 `billing_credit_ledger` 上留下对应的 commit + release 两条记录。这是 token 计费相对图片计费**唯一的结构性新增**，不做的话要么按预留上限超收，要么按预估欠收。
