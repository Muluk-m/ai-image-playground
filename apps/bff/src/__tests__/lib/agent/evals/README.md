# 对话式生图 Agent 黄金评测集

这套评测钉住的是 **Agent 运行时的确定性规则**，不是模型会不会写好提示词。
每条用例用 mock 的对话模型流（`setAgentFetchForTesting` + `scriptedAgentFetch` /
`toolCallCompletion`）回放脚本化输出，再断言运行时实际做了什么。

- 不打真实对话上游，也不打真实生图上游（出图模式只把任务写入队列，不跑 worker）。
- 不消耗生成额度；评测配置未打开 `billing:credits`。
- 改系统提示词、工具清单、出图/确认模式、系统事实或熔断逻辑之后，应先跑这一组，
  看行为有没有退步。

## 怎么跑

在仓库根目录：

```sh
pnpm --dir apps/bff test --filter src/__tests__/lib/agent/evals/golden-evals.test.ts
```

需要 `TEST_DATABASE_URL`（与其它 BFF 数据库测试相同）。不要用 `bun test` 一次加载多个 BFF 文件。

## 怎么加一条用例

1. 在 `golden-evals.test.ts` 里加一个 `it('…', …)`，标题写清钉住的运行时契约。
2. 用 `harness.ts` 的 `startConversation` / `runTurn` 走真实起轮路径；模型输出一律脚本化，不要让测试去「猜」模型。
3. 断言只针对运行时能保证的事情，例如：
   - 发给模型的工具清单里有没有某把工具；
   - 有没有发出对话模型请求；
   - 草稿卡还是队列任务；
   - 最终提示词有没有被 `designPrompt` 改写；
   - 用户消息里有没有注入系统事实；
   - 同一错误连续失败后是否熔断。
4. 把新用例的 id 和一句话说明补进下面的清单，以及 `golden-evals.test.ts` 顶部的目录注释。

不要在这里测「这句话该澄清还是直出」这类模型判断；那不是运行时能保证的。

## 当前用例

| id | 钉住的行为 |
|---|---|
| `canvas-forbids-batch-tools` | 画布模式不向模型提供 `planImageBatch` / `proposeBatchGeneration`；对话模式在能力打开时提供 |
| `direct-image-skips-model` | 直出模式用用户原话调用 `generateImage`，这一步不先问对话模型；结构化英文 prompt 不填 `designIntent`、不改写 |
| `design-intent-rewrite` | 模型若填写了完整 `designIntent`，运行时会把它并入最终提示词（对照直出不改写） |
| `confirm-mode-drafts` | 确认模式（未开 `autoSubmit`）只拟稿，不建队列任务 |
| `generate-mode-enqueues` | 出图模式当场入队，卡片为已提交，库里有任务行 |
| `system-facts-pending-draft` | 待确认草稿写入本轮用户消息的系统事实 |
| `system-facts-completed-batch` | 已完成批次写入系统事实，并附带短确认语指引 |
| `tool-same-error-circuit` | 同一工具同一错误连续失败达到上限后熔断，不再真正执行 |
| `overload-no-output-retry` | 对话上游在产出前过载时重试，成功后用户只看到一次完整回复 |
| `short-confirmation-current` | **当前行为**：批次已完成后用户再说短确认语，服务端仍会问模型（系统事实已提示不要再生成）。服务端硬拦截由并行的 PR 1 实现，见文件中的 `it.todo` |

## 短确认语与 PR 1

并行 PR 正在做服务端拦截短确认语。本评测集不实现该拦截：
`short-confirmation-current` 记录合并前的行为；`it.todo` 留给 PR 1 合并后改成「不再调用对话模型或生成工具」。
