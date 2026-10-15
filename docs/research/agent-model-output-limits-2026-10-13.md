# Agent 模型输出额度核验（2026-10-13）

## 配置结论

`models.config.json` 按模型 ID 登记 contextWindow 与 maxTokens；thinking 档位只选择模型和推理力度。
已登记模型优先于遗留 `AGENT_CHAT_MAX_TOKENS=8000`，未登记自定义模型继续使用显式环境配置兜底。

| 模型 | 官方单次最大输出 | 本服务预算窗口 | 网关 max_tokens 参数验收 |
| --- | ---: | ---: | --- |
| gpt-6-luna | 128000 | 1000000 | 128000：HTTP 200、正常 stop |
| gpt-6.1-sol | 128000 | 1000000 | 128000：HTTP 200、正常 stop |
| claude-opus-5-5 | 128K | 1000000 | 128000：HTTP 200、正常 stop |
| gpt-5.6-luna（旧默认） | 128000 | 1000000 | 128000：HTTP 200、正常 stop |

官方来源：[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、
[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、
[Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview)。
OpenAI 官方窗口为 1050000；本服务沿用保守的 1000000，不在此次扩大输入窗口。

Opus 的 [迁移指南](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
说明 max_tokens 同时覆盖思考与可见回复。此前两次失败的实际 output 都为 8000，输入约 35K/40K，
是本服务的输出配置触顶，不是输入上下文需要压缩。

## 实际中转与验证边界

从生产 VPS 调用现用 sub2api 网关，使用服务内已有凭据，流式 Chat Completions，
设置 `max_tokens=128000`，要求只答 OK。三档分别使用线上 low/medium/high 推理力度，旧默认模型也通过相同参数验收，
全部 HTTP 200、finish_reason=stop，输出仅 4–5 token。
这是参数兼容验收，不代表实际生成满 128K，也不能排除中转内部另行裁剪参数。
回归测试另外验证 SDK 实际发出的 max_tokens，以及超过旧 8K 额度的模拟输出能完整透传。

Pi 0.85.1 的 `buildBaseOptions` 默认使用 model.maxTokens，但会按剩余上下文空间下调。
因此输入压缩与出站硬闸直接预留完整 maxTokens；旧统一 output reserve 配置保留兼容读取，
不再参与预算计算，避免它压低大模型额度或挤占小模型输入空间。
摘要任务仍保留独立的 1500 token 输出预算，不能跟随主对话放大。

## Craft Agents 对照

查阅提交 `2e3ba53ff80b229a07e9d1884dc58f6733f22e1f`：

- [model-resolution.ts](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/pi-agent-server/src/model-resolution.ts)
  从 Pi 的模型目录解析内置模型能力。
- [custom-endpoint-models.ts](https://github.com/craft-ai-agents/craft-agents-oss/blob/2e3ba53ff80b229a07e9d1884dc58f6733f22e1f/packages/pi-agent-server/src/custom-endpoint-models.ts)
  自定义端点却固定 maxTokens=8192，注释明确说无法查询端点能力而使用默认值。

本服务使用中转端点，不照搬其 8192 默认值；采用经官方文档和当前上游参数验收的模型登记表。
模型协议仍有有限输出上限；到达真实上限时继续保留失败处理，不能把不完整工具参数当成完整操作执行。

## 2026-10-15：暂时停用 Claude

深度档切换为 `gpt-6-astra`（high），下一句预测从 Haiku 切换为 `gpt-6-luna`；
轻量 Luna、中等 Sol 不变。当前额度登记表只保留这三个 GPT 模型。

从生产 VPS 使用现有网关和服务凭据发送真实 Chat Completions：
- Astra：`max_tokens=128000`、`reasoning_effort=high`，HTTP 200、`finish_reason=stop`，
  正常返回要求的 JSON（输入 18、输出 11 token）。
- Luna：使用下一句的 `max_tokens=400`，HTTP 200、`finish_reason=stop`，
  正常返回要求的 JSON（输入 18、输出 11 token）。

Astra 沿用 100 万输入预算窗口和 128000 输出预算。本次验证参数接受与短响应完成，
不代表实测满窗口或输出满 128K，也不将上表的旧模型官方额度结论转用为 Astra 的官方额度。
