# 对话内历史图片引用：竞品证据

核实日期：2026-10-10。以下依据官方文档与源码，未运行竞品实例做端到端验收。

## LibreChat

LibreChat 的已核实实现是“保存图片与 ID，让编辑工具按 ID 找回媒体”，能够直接编辑本轮未重新附上的历史生成图；这和“让 Agent 主动重新观看旧图的像素”是两个能力。

### 已核实行为

- **历史图片可直接作为编辑输入。** 官方文档说明编辑工具的 `image_ids` 可引用当前附件或此前生成、引用过的图片。源码先在当次 `imageFiles` 查找；缺失 ID 时查询持久文件记录，过滤条件是当前 `user`、`file_id`、存在宽高，再用文件对应的存储策略取得下载流加入编辑请求。这条路径不要求用户重新上传，也不是只识别当轮附件。[官方文档](https://www.librechat.ai/docs/features/image_gen#generation-vs-editing)、[OpenAIImageTools.js，L259–325](https://github.com/LibreChat-AI/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/api/app/clients/tools/structured/OpenAIImageTools.js#L259-L325)
- **生成与编辑结果返回稳定 ID。** 生成结果的文本含 `generated_image_id`，编辑结果还含 `referenced_image_ids`。工具说明提示模型在后续调用继续使用这些 ID；当轮附件的 ID 列表也会加入工具上下文。[OpenAIImageTools.js，L218–225](https://github.com/LibreChat-AI/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/api/app/clients/tools/structured/OpenAIImageTools.js#L218-L225)、[OpenAIImageTools.js，L388–397](https://github.com/LibreChat-AI/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/api/app/clients/tools/structured/OpenAIImageTools.js#L388-L397)、[imageContext.ts](https://github.com/LibreChat-AI/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/packages/api/src/tools/toolkits/imageContext.ts)
- **图片像素不会随所有后续轮次重复注入。** 官方文档明确生成图按配置存储，生成或编辑完成后立即送入模型上下文；后续若想再次给模型视觉上下文，需要从侧栏把旧图附到消息，无需重新上传文件。不能把“编辑工具能根据 ID 下载原图”描述成“对话模型每轮都还能看见生成图”。[Image Storage and Handling](https://www.librechat.ai/docs/features/image_gen#image-storage-and-handling)
- **上下文裁剪后仍有局限。** 官方文档把继续引用历史 ID 限定为 ID 仍在上下文窗口内；工具 schema 又要求只能使用上下文中仍可见的 ID、不能编造。因此以上证据不能证明它在压缩/裁剪丢失 ID 后，还能自行列出会话所有图片并重新观看。在已检查的 OpenAI 图片 toolkit 中，公开工具是生成与编辑，未核实专用的“会话图片目录 + 按 ID 返回视觉内容”工具。[官方文档](https://www.librechat.ai/docs/features/image_gen#generation-vs-editing)、[oai.ts，L101–134](https://github.com/LibreChat-AI/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/packages/api/src/tools/toolkits/oai.ts#L101-L134)

### 对本项目的启示（由上述证据推导）

至少应保证会话里的上传图和生成图均能以稳定身份被编辑工具取回，不能因为图片不在当轮附件就要求重传。若目标还包括 Agent 在长会话中主动找到“前面那三款 Logo”、检查其实际背景和文字，则需要独立的会话图片检索与观看能力；编辑工具读取原图用于上游请求，并不自动满足这个目标。

LibreChat 当前源码读取历史媒体的校验范围是**当前用户**，不包含 `conversationId` 条件。本项目若按“同一个 session 的图片”建立读取规则，应结合自身会话权限边界设计，不能照搬竞品过滤条件。

### 源码核实范围

官方仓库 `LibreChat-AI/LibreChat`，读取 `main` 时的树提交为 `e1dfc10449ff713faffacd60273fddcfe2c0a698`。已读取：

- `api/app/clients/tools/structured/OpenAIImageTools.js`
- `packages/api/src/tools/toolkits/oai.ts`
- `packages/api/src/tools/toolkits/imageContext.ts`

未基于该源码快照运行部署或测试；有关上下文裁剪后的边界主要依据官方产品文档与工具参数说明，未声称完整排查所有扩展、MCP 工具或代码工具。

## Open WebUI

- `generate_image` / `edit_image` 将结果保存到对应 chat message 的 files；编辑工具接受 `image_urls` 并交给服务端读取，旧图片 URL 可以继续作为输入。[builtin.py](https://github.com/open-webui/open-webui/blob/8bd8b4fac5e059578ac0c74b3c18d11139f88b7d/backend/open_webui/tools/builtin.py#L370-L508)
- `add_file_context` 从持久聊天记录中取附件，向用户消息注入包含 id、url、名称、类型的标签，给原生工具调用提供引用。它仍与发送的消息窗口相关，不能据此保证任意被压缩图片都能自主找回。[middleware.py](https://github.com/open-webui/open-webui/blob/8bd8b4fac5e059578ac0c74b3c18d11139f88b7d/backend/open_webui/utils/middleware.py#L1771-L1825)
- 官方说明生成/编辑工具返回的图片会作为视觉输入送给模型；Chat Completions 会拆出图片放入额外用户消息，Responses 则通过工具结果传递。[官方工具说明](https://docs.openwebui.com/features/extensibility/plugin/tools/#images-in-tool-results)
- 已检查的 `view_file` 读取 `file.data.content` 文本，不能将其描述为按历史文件 ID 读取图片像素的工具。未核实完整的压缩后会话图片发现与观看保证。[builtin.py](https://github.com/open-webui/open-webui/blob/8bd8b4fac5e059578ac0c74b3c18d11139f88b7d/backend/open_webui/tools/builtin.py#L2750-L2855)

## 本项目现状与建议

本节依据当前仓库源码，属于本项目诊断和设计建议，不是竞品已经实现的功能。

- 已有 `viewImage` 按图片 ID 返回预览、原图或局部视觉内容（`apps/bff/src/lib/agent/tools/viewImage.ts`）。
- 历史生成图读取及折叠后按 ID 回查仍依赖队列 `tasks` 与 `result_payload`（`apps/bff/src/lib/agent/images.ts`），而持久生成记录和原图媒体已另行存储。
- 批次计划只从用户消息附件中找持久引用，没有共用完整的图片来源解析（`apps/bff/src/lib/agent/batch-plans.ts`）。
- 摘要提示模型保留产物 ID，但产物清单是模型生成的有界字符串；没有独立的会话图片目录查询工具（`apps/bff/src/lib/agent/compaction-summary.ts`）。有 ID 时能读，不等于丢失 ID 后还能发现旧图。

建议以同一会话为边界形成完整路径：查询图片目录（稳定 ID、来源轮次/消息、时间、原始提示词等元数据，分页），按 ID 用现有 `viewImage` 获取实际像素，单图编辑与批次计划共用持久引用解析。批次保存时冻结输入并建立媒体认领。目录和媒体解析依赖持久记录，不依赖模型摘要是否保留全部 ID，也不依赖任务队列是否仍保留历史任务。

验收案例：生成三款 Logo 后，用户仅说“前面三款去字、白底”；Agent 能定位三张图，必要时自主看图，并建立包含三个原图引用的待确认计划。刷新、历史压缩和任务队列清理后仍应成立；不得将同一用户其他会话的图片自动加入当前任务。
