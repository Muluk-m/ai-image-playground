# 0028 GPT 双通道：OpenAI 直连 + sub2api

状态：已确认方向，实现中（分支 `feat/gpt-dual-route`，基于 #1604；整个需求一个 PR 上线）。

## 决策（Nain 2026-10-31 确认）

- 两条通道共用 `openai-compat` provider，下面各接一层参数适配：
  - **sub2api 适配**：提示词注入（`PROMPT_REWRITE_GUARD_PREFIX` + `buildAspectInstruction` 比例句）与多图 fan-out（一个任务拆成多个单图上游任务再合并）。
  - **直连适配**：size / quality / n 走原生参数，不注入；已入库带注入的旧任务用 `unshapeQueuePrompt` 剥掉。
  - 注入从提交时（`apps/web/src/lib/api.ts`、`apps/bff/src/lib/agent/prompt-shaping.ts`）挪到发送时的 sub2api 适配层，入库 prompt 保持原文。
- 直连只上 `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`。
- 选路：会员默认直连，直连满（IPM / 在途 / 429 冷却 / 预算到顶）或不可用立即切 sub2api，不排队；非会员默认 sub2api，只有 sub2api 熔断才借直连。会员判断用私有 hook `accountSummary().isMember`。
- 非会员只开 1K medium（现在只拦 4K，`private/apps/bff/billing/service.ts` `canSubmitTask`），前端选择器同步。
- 会员回落到 sub2api 参数不满足时静默降级：4K→2K、原生 n→fan-out，不提示。
- 定价：会员档位按 `unitMultiplier` 加倍率（按 OpenAI 成本比例出一版倍率表放 PR 审），降级时按实际出的档位结算。
- 超时换路重试一次：在硬超时（15 分钟）内设单路超时（约 90 秒未出结果即换路），剩余时间不够直接失败退款；直连已花成本平台承担。
- 预算：自然月（台北时间），按自估成本累计，封顶比例默认 100%，`200 USD × 比例` 到顶即直连不可用；80%/100% 发运维告警。
- 限流沿用 #1604：直连每模型 16 IPM、合计在途 8、429 冷却 60s；sub2api 全局在途 8，各环境本地限。调度器需新增「拿不到立即返回」接口给会员选路用。
- 三把 key 分开：sub2api（`UPSTREAM_*`）、Vertex、OpenAI 直连（新增 `OPENAI_DIRECT_BASE_URL` / `OPENAI_DIRECT_API_KEY` / 组织 ID）。

## 待办

1. Key：Nain 放到 `~/.config/ai-image-playground/secrets/openai-direct.env`（`OPENAI_DIRECT_API_KEY=`，600）。到位后探测 flare/sunburst 直连支持的尺寸，校准单价（10-30 实测 1K low 约 0.0055 USD/张）。
2. 实现：直连配置与适配层 → 注入下沉 → 调度器非阻塞获取 → 选路与熔断 → 超时换路 → 预算记账与告警 → 模型目录档位与会员限制 → 倍率定价（私有 overlay）。
3. 迁移编号：#1604 的 `0080_upstream_scheduler` 与 CLI 分支 `0080_cli_scopes` 撞号（同 `when`），CLI 分支还丢了 `0079_cli_device_oauth` 的 journal 条目；预算表另起新号，合并前按 main 实际情况重排。
4. 测试环境真 key 实测（预算 ≤ 2 USD），附截图后开 PR，合并前 Nain 确认。
