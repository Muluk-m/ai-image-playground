# 收拢「图片档位策略」module：现状与后续方案

来源：架构评审（2026-11-07）候选 1「收拢图片档位策略 module」。本文写于 2026-11-07，基于 main `cc1ca5f7b`。

## 目标

档位、会员收口、积分倍率的规则只在一个 module（`packages/shared/src/image-tier.ts` 的 `resolveImageTier`）里改。
提交、worker、结算、前端报价都读它的结果，做到「报价倍率 = 提交倍率 = 结算倍率」。

## 已完成

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | #1745：用 16 个用例钉住「提交入口 × 模型系列 × 会员」的现有行为（`imageTierEntries.test.ts`） | 已合并 |
| 2 | #1748：新增 `resolveImageTier`；BFF 提交路径合并为 `alignImageTier`；入口显式传 `entry`；`tasks.metering.tier` 记录 `entry`、`memberApplied`、`requires` | 已合并（`d999c5d47`），生产已上线 |
| 4a | #1754：前端报价函数改走 `resolveImageTier`，与旧实现逐项等价，不改价格 | 已合并（`6911fec3e`），前端已上线 |

#1748 的测试环境证据（已写进 PR）：

- 非会员 GPT 4K high 在界面上被锁到 2K，出 2048×2048；同一账号开会员后出 2880×2880。
- 四条任务的 `metering.tier` 都已写入。

## 原第 3 步不需要做（结论有变）

原计划：worker（`task-runner.ts:242`）与结算（`task-transitions.ts:214`）改读 `metering.tier`。

核对代码后发现，这两处用的是 `isGptSub2apiDeliverable(task.request)`（1K 且非 high 才能走 sub2api）。

- 它的输入 `task.request` 已经是 `resolveImageTier` 收口后落库的最终请求。也就是说，worker 和结算已经在读「档位决定」，只是读的是请求本身，不是 `tier` 字段。
- `tier.requires.membership` 只表示「请求是 4K」，和「sub2api 能否兑现」不是一回事：2K 或 high 请求的 `requires.membership` 是 false，但仍不能走 sub2api。直接替换会改变选路和退差价，不等价。
- 另起一个落库字段存「sub2api 能否兑现」也没有收益：它可以从落库请求直接算出来，冻结一份只会多一个可能不一致的副本。
- worker 运行时再查一次会员（`isActiveMember`），决定的是会员优先走 OpenAI 直连。这属于**选路**，对应评审的候选 6「GPT 双通道选路抽成 router」，不是档位策略。

结论：第 3 步不改代码。worker 和结算的选路、退差价规则留给候选 6 一起做。

## 剩下要做的

### 第 4 步：前端报价改读 `resolveImageTier`（4a 已完成，剩 4b）

涉及：`apps/web/src/lib/{gptPremium,imageCharge,gptQuote}.ts`，以及调用方 `InputBar`、`CanvasGenerateBar`、`CanvasBatchBar`、`NodeStoryboard`、`ImageNodeComposer`、`CanvasEditPromptDialog`、`canvasImageEdits`、`generationJob`。

做法：

1. 前端每个报价入口映射到和提交一致的 `entry`（输入框 → `web-direct`，画布批量 / 分镜 → 对应的 `batch` / `stage` 等），会员身份来自 `/api/gpt/premium`，用 `resolveImageTier(...).rateMultiplier` 报价。
2. 删掉 `quotedGptMultiplier` / `composerImageRate` 里各自的收口逻辑。
3. 表格测试断言：同一组输入，前端报价倍率 = BFF 提交 `metering.unitMultiplier`。

注意：评审标记了疑似 bug「画布非会员按 4K 报价」。修它会改变用户看到的价格，属于行为变更，合并前要 Nain 确认。建议拆两个 PR：

- 4a（已完成，#1754）：报价改走 `resolveImageTier`，保持现有报价不变；`imageCharge.test.ts` 里已用一条测试钉住「画布非会员 Gemini 4K 按会员档报价」，4b 修正时同步改断言。
- 4b：修正不一致的报价（行为变更，Nain 确认）。

### 第 5 步：`GEMINI_TIER_MULTIPLIERS` 收回能力目录

`packages/shared/src/gpt-direct.ts:164` 手抄了一份 Gemini 档位倍率，和 ADR-0027「单一来源」冲突。改为从能力目录读取。应当无行为变化，但动到计价，测试要钉住每个模型、每个档位的倍率不变。

### 收尾：删过渡脚手架

`apps/bff/src/__tests__/lib/imageTierEntries.test.ts` 是第 1 步留下的过渡测试。确认 `packages/shared/src/__tests__/image-tier.test.ts` 已覆盖全部矩阵后删除。

## 已知问题（不在本条线内修）

AI 评审在 #1748 上提的 3 条 P1，都是重构前就有的行为，已记录在 #1752：

1. 准备（`prepareQueueTask`）与提交（`createQueueTask`）之间会员状态变化，会让提交时重新收口的请求和准备时的哈希不一致，报 `prepared_queue_request_mismatch`，并且没释放已归档的输入。
2. `commandHash` 不含 `entry` / 严格标志，一个入口准备的结果可以被另一个入口复用。
3. 同 1：准备结果没有冻结会员位。

这几条属于评审候选 2「生成提交 module 收回准备 / 提交 / 丢弃」，适合在那条线里一起修。

## 已澄清的问题

- **`memberApplied` 为 false**：web-direct 入口提交时 `needsMember` 为 false，不查会员位，4K 由 overlay 的 `canSubmitTask` 门禁拦。类型注释已写明「没查询就是 false，不代表账号不是会员」。不能用它判断会员身份。
- **GPT 2K 与 4K 倍率同为 8.1**：Image 2.6 的价目表 `STILL_CREDITS` 中 2K 和 4K 同价（high 都是 810 积分，`packages/shared/src/gpt-image-26.ts:34`），是既有口径。

## 测试环境遗留状态

- 测试账号 `maqiqian0316` 被手工开了 1 个月「入门」套餐（约 2026-12-07 到期，未关联付款）。
- 测试环境 `operator-config.json` 已补齐生产的能力与配额（`agent:batch-analysis`、`agent:bulk-attachments` 及 attachment / batch / visual-prepare 配额），测试独有开关保留，`accounts:email-verification` 保持关闭（测试环境没有 `RESEND_API_KEY`）。改动前没有备份成功；还原只需删掉上面列出的新增键。

## 建议顺序

1. ~~开 issue：上面 3 条既有问题~~（已开 #1752）。
2. ~~第 4a 步~~（已完成，#1754）。
3. 第 4b 步（修正报价不一致，Nain 确认）。
4. 第 5 步（Gemini 倍率收回目录）。
5. 删过渡测试。
6. 下一条线：候选 6（选路 router），把 worker 与结算里的 `isGptSub2apiDeliverable` 和运行时会员查询一起收进去。
