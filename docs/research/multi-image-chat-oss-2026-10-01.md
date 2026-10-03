# 多图片聊天与批量处理：开源项目源码调研

调研日期：2026-10-01（Asia/Shanghai）。本次只做研究，没有修改业务实现，没有运行这些项目或做压力测试。

## 结论

1. **不能把“主流 API 支持文件 ID”推导成“开源聊天产品已普遍摆脱 base64”。** 本次抽样中，多个项目在持久层使用文件/素材 ID，但实际发给模型时仍还原为 base64。素材存储、客户端到自有后端的传输、后端到模型的传输，是三个不同问题。
2. **值得借鉴的是分层治理。** 文件存储解耦、图片预处理、历史工具图片回放窗口、视觉 token 估算、摘要请求自己的输入预算，分别解决不同限制。单独换 URL 或只做文本摘要均不够。
3. **没有证据证明“用户发 100 张图→自动拆成独立上下文→持久批次→按项恢复”是这批聊天项目的共同机制。** 未确认不等于不存在；本次限定到所读调用路径。多模型并发、聊天消息排队、工具并发，也不能替代该证据。
4. **我们的完整批量任务方案应定位为产品能力建设。** 多图可靠性第一步可以先补媒体引用入口、实际请求字节预算、历史视觉输入治理，再决定是否把批次卡和逐项执行作为下一阶段。
5. 星数只帮助扩大样本，不代表实现正确、已上线或适合我们的付费图片执行场景。默认分支代码也不等于最近发布版。

## 调研方法与范围

- 样本共 13 项：Open WebUI、LibreChat、Cherry Studio、Chatbox、Jan、ChatALL、SillyTavern、AstrBot、AionUi、CoPaw、big-AGI、AIChat、Page Assist。
- 前两项作为常见参照；其余覆盖桌面、浏览器扩展、CLI、角色聊天、多渠道 Agent。ChatALL/Jan 等不适合作成熟多图正面样本的项目也保留，避免只挑符合预设方案的证据。
- GitHub REST 查询仓库 stars、默认分支 HEAD 和文件树，再读取固定 commit 的源文件；检索官方 issue/PR 作为补充。
- 重点区分：持久化格式、模型出站格式、视觉预算、历史策略、真正的批量执行与恢复。
- 下文逐项记录源码证据、版本 SHA 和未核实边界。没有依据 README 的功能名推断内部架构。

## 两个参照项目

### Open WebUI：自有文件引用，出站再次转 base64

- 仓库：`open-webui/open-webui`；stars **153,694**，来自 [GitHub API](https://api.github.com/repos/open-webui/open-webui)。固定 SHA：`8bd8b4fac5e059578ac0c74b3c18d11139f88b7d`。
- **普通持久聊天先上传文件**：上传完成后记录 file ID 和引用；临时聊天则可以保留 data URL。不是所有聊天模式都用同一种存储形态。[上传路径](https://github.com/open-webui/open-webui/blob/8bd8b4fac5e059578ac0c74b3c18d11139f88b7d/src/lib/components/chat/MessageInput.svelte#L1002-L1037)、[图片入口与临时聊天分支](https://github.com/open-webui/open-webui/blob/8bd8b4fac5e059578ac0c74b3c18d11139f88b7d/src/lib/components/chat/MessageInput.svelte#L1134-L1191)。
- **模型请求仍可能携带 base64**：`convert_url_images_to_base64` 遍历消息的 `image_url` / `input_image`，解析图片引用后改成 data URL；普通请求路径调用这个转换。[转换函数](https://github.com/open-webui/open-webui/blob/8bd8b4fac5e059578ac0c74b3c18d11139f88b7d/backend/open_webui/utils/middleware.py#L2170-L2220)、[调用点](https://github.com/open-webui/open-webui/blob/8bd8b4fac5e059578ac0c74b3c18d11139f88b7d/backend/open_webui/utils/middleware.py#L2538)。读取失败时还有保留原值的分支，不能说所有外部 URL 都必定被转码成功。
- **预处理由配置控制**：按用户设置与管理员尺寸上限压缩；未设置时并不保证默认缩图。[压缩选择](https://github.com/open-webui/open-webui/blob/8bd8b4fac5e059578ac0c74b3c18d11139f88b7d/src/lib/components/chat/MessageInput.svelte#L1143-L1169)。
- **有上下文压缩，但视觉估算是启发式**：该函数对 `image` / `image_url` 块固定估 1000 token，而非按最终 JSON 字节数控制请求体。[估算函数](https://github.com/open-webui/open-webui/blob/8bd8b4fac5e059578ac0c74b3c18d11139f88b7d/backend/open_webui/utils/context_compaction.py#L424-L444)。这不能被当作所有模型准确的视觉 token 公式，也不足以保护 HTTP body / 进程内存。
- **未核实**：聊天多图入口是否自动建立持久逐图任务与独立分析上下文。本次不因存在后台任务/Agent 功能就宣称已具备完整批处理闭环。

### LibreChat：素材 ID 驱动编辑，附件限制与供应商适配分开

- 仓库：`LibreChat-AI/LibreChat`；stars **45,171**，来自 [GitHub API](https://api.github.com/repos/LibreChat-AI/LibreChat)。固定 SHA：`f10b1d91f1eee3a2c82d5247bf620351486b7c1b`。
- **本地上传先缩图再存文件**，本地素材生成模型 payload 时又读文件编码为 base64。[本地上传与读取](https://github.com/LibreChat-AI/LibreChat/blob/f10b1d91f1eee3a2c82d5247bf620351486b7c1b/api/server/services/Files/Local/images.js#L31-L105)。
- **出站格式依存储和供应商而变**：存在 base64-only 分支，最终可以生成 URL、data URL、Anthropic base64 source 等；不能说 LibreChat 一律上游 file ID，也不能说所有存储后端均同样处理。[适配分支](https://github.com/LibreChat-AI/LibreChat/blob/f10b1d91f1eee3a2c82d5247bf620351486b7c1b/packages/api/src/files/encode/image.ts#L62-L75)、[输出格式](https://github.com/LibreChat-AI/LibreChat/blob/f10b1d91f1eee3a2c82d5247bf620351486b7c1b/packages/api/src/files/encode/image.ts#L187-L218)。
- **分辨率有独立策略**：low、high、自定义比例/尺寸分别处理，保留纵横比和不放大约束；这些源码常量不是供应商当前限制的权威来源。[resizeImageBuffer](https://github.com/LibreChat-AI/LibreChat/blob/f10b1d91f1eee3a2c82d5247bf620351486b7c1b/api/server/services/Files/images/resize.js#L19-L84)。
- **附件数量、已知文件字节、提取文字字符数分别检查**，还可按场景重复计量同一附件。这里的 bytes 是文件 metadata，不是已经序列化的 HTTP JSON 大小，不应混淆。[统计与限制](https://github.com/LibreChat-AI/LibreChat/blob/f10b1d91f1eee3a2c82d5247bf620351486b7c1b/packages/api/src/agents/attachments.ts#L255-L348)。
- **生图/改图工具通过图片 ID 获取素材**：工具上下文只需列出 `image_ids`，允许引用历史和生成图；编辑实现按这些 ID 查询文件并保持输入顺序。[工具素材清单](https://github.com/LibreChat-AI/LibreChat/blob/f10b1d91f1eee3a2c82d5247bf620351486b7c1b/packages/api/src/tools/toolkits/imageContext.ts#L1-L40)、[编辑解析](https://github.com/LibreChat-AI/LibreChat/blob/f10b1d91f1eee3a2c82d5247bf620351486b7c1b/api/app/clients/tools/structured/OpenAIImageTools.js#L234-L291)。它支持“工具拿 ID 执行”的设计，不等于图片没有进入任何视觉上下文。
- **未核实**：自动把大量上传图片转换为持久逐项任务、独立视觉上下文以及完整按项恢复。此处仅背书已读到的附件与编辑调用路径。

## 对本项目方案的修正

### 已有能力应保留

当前工作区已经有 `mediaId`、多图只发清单、`viewImage` 预览/局部读取、会话压缩与出站 token guard。此前讨论不能被理解成这些能力需要从零重建。现场定位：

- `apps/web/src/features/agent/lib/turnSubmission.ts`：有云媒体通道时把无 mask 的本地图转成媒体引用。
- `packages/shared/src/agent.ts`：50 个总引用、8 个内联引用、超过 3 个媒体引用只给清单。
- `apps/bff/src/lib/agent/images.ts`：`shownTurnReferences` / `shownImageRequests` 决定实际视觉输入；内联原件仍会进入模型输入。
- `apps/bff/src/lib/agent/tools/viewImage.ts`：一次最多 4 张，默认 preview，支持 full/region。
- `apps/bff/src/lib/agent/compaction-transform.ts` 与 `request-budget.ts`：会话塑形、摘要失败截尾、模型出站 token 硬闸。

这些是当前工作区源码事实，未在本次研究重新验证部署版本或复现用户失败请求。

### 第一优先级：多图输入与历史治理

1. **统一持久素材引用**：把附件与遮罩补齐到自有素材服务，消息保存 ID/顺序/用途；不要直接把素材 ID 当供应商 file ID。
2. **增加实际请求字节预算**：最终供应商适配后的请求体才是字节预算检查面。预览尺寸、单图大小、累计视觉 token、并发内存另行约束。可先用元数据预估，最终序列化再精确核验，避免只在末端报错。
3. **管理历史视觉工作集**：按本轮显式引用、正在处理的图、近期工具图选择像素输入；其他图片保留 ID 与已经获得的结论。借鉴 Chatbox 的工具图窗口，但不照抄“最近 5 张”为所有场景全局规则。比较任务必须保留联合视觉证据。
4. **摘要链路单独验收**：不能把数十张原图原样丢给摘要器。已知图片结论和素材引用保留，未分析图片不能通过 `[image]` 占位符凭空变成视觉记忆。Cherry 的处理说明了这一边界。
5. **上游传输按能力适配**：可用 URL / Files API 的通道可以使用，但也要处理可访问性、有效期及权限；兼容通道仍可使用有预算的 base64。最终目标是可控请求，而非绝对禁止 base64。

### 第二优先级：批量执行产品能力

- 只有可独立的图片任务才拆分上下文；跨图比较、连续叙事、统一风格参考需要保留关联。
- 在现有图片任务队列之上设计 batch 与 item 关联、明确输入顺序、规则版本、输出和费用归属，不因调研而默认引入新队列基础设施。
- 付费任务一旦已被上游接收，恢复时优先查原任务状态；结果未知不可重新提交。CoPaw 的 creator 插件提供局部参考，不能宣称其普通聊天入口就是完整批量方案。
- 批次进度卡、暂停后续项、按项失败恢复，应当以真正用户场景验收，不能通过“使用子 Agent / 多模型并行”来代替验收。

## 验收建议（尚未实施）

| 场景 | 要证明的行为 |
| --- | --- |
| 一次添加 100 张普通图 | 素材清单不会把 100 张原件全部塞入一份模型请求 |
| 少量超大图 | 字节预算能在发请求前生效，不依赖 token 压缩偶然触发 |
| 多轮持续看图 | 历史图片工作集有界，素材仍可按 ID 重新读取 |
| 压缩时含大量图 | 摘要请求本身不过载；保留有出处的结论与图片身份 |
| 多图比较 | 没有因为机械裁旧图破坏同时比较的证据 |
| 断网/刷新/重启 | 已接受的付费任务可核对，不因恢复而重复提交 |

以下是其余 11 项的固定版本源码记录。


## 桌面客户端样本

读取 GitHub 官方 repo API 的 default branch / commits / recursive tree，再按文件下载 raw source。没有 clone/build/运行产品。Stars 为查询时快照，不能代表功能质量；以下主干不等于发布版。没有验证到的能力写未核实，不作全局否定。

| 项目 | Stars | 审阅 commit |
|---|---:|---|
| CherryHQ/cherry-studio | 52,298 | 72e10496566a234ad1b48f2aa9017471ca740e57 |
| janhq/jan | 44,734 | e0c62f863a1b930ed625085979a3d62c947635d9 |
| chatboxai/chatbox | 41,916 | 0ac6385ae1ff5bf778777826da3c5edcd55b61b8 |
| sunner/ChatALL | 16,503 | 6d089c2ab72dde2ba1010cc1e910ceb766458546 |

Stars 来源分别是 https://api.github.com/repos/CherryHQ/cherry-studio 、https://api.github.com/repos/janhq/jan 、https://api.github.com/repos/chatboxai/chatbox 、https://api.github.com/repos/sunner/ChatALL 。

### Cherry Studio：本地引用，发模型时仍内联；值得借鉴的是压缩请求自身的保护

- **已证实：文件 ID 并没有消除上游 base64**。消息保存 `providerMetadata.cherry.fileEntryId` 或本地 `file://`；发送前读磁盘转成 `data:...;base64`。本模块明确说明 Gemini/OpenAI Files API 未接入、大文件仍内联；实现与说明一致：[fileProcessor.ts L1–14、L55–81、L88–126](https://github.com/CherryHQ/cherry-studio/blob/72e10496566a234ad1b48f2aa9017471ca740e57/src/main/ai/messages/fileProcessor.ts#L1-L126)。因此不能把其本地 FileEntryId 当供应商 Files API 引用。
- **已证实：压缩器不再接收图片二进制**。给摘要模型之前，把附件替换成 `[image: filename]` 等标记；压缩请求还要独立检查 token budget，防止压缩调用自身超限：[janitor.ts L65–112](https://github.com/CherryHQ/cherry-studio/blob/72e10496566a234ad1b48f2aa9017471ca740e57/packages/aiCore/src/core/context/janitor.ts#L65-L112)、[L228–264](https://github.com/CherryHQ/cherry-studio/blob/72e10496566a234ad1b48f2aa9017471ca740e57/packages/aiCore/src/core/context/janitor.ts#L228-L264)。注意：摘要拿到占位符，不等于自动获得每张图片的语义描述。
- **已证实：有视觉 token 估算函数**。按供应商协议估算，已知尺寸和未知尺寸分别处理；源码明确承认它是启发式，没有区分全部模型版本：[imageTokens.ts L1–45](https://github.com/CherryHQ/cherry-studio/blob/72e10496566a234ad1b48f2aa9017471ca740e57/src/main/ai/tokens/imageTokens.ts#L1-L45)。不可照抄为所有 GPT/Gemini 型号精确计费公式。
- **未核实**：自动将一条“处理 100 图”拆成 100 个独立上下文、有持久批次和按项恢复。本次代码足以支持传输/压缩结论，不足以支持该产品级批量闭环。

### Chatbox：存储引用 + 按需看图 + 历史工具图片回放上限

- **已证实：本地存储与消息解耦**。saveImage 把 base64 存 blob storage，再返回 storageKey：[image.ts L4–8](https://github.com/chatboxai/chatbox/blob/0ac6385ae1ff5bf778777826da3c5edcd55b61b8/src/renderer/utils/image.ts#L4-L8)。转模型消息时通过 resolver 再拿 data URL、剥离头部得到 base64 并作为 image/file part：[model-message-converter.ts L17–20、L58–68、L169–190](https://github.com/chatboxai/chatbox/blob/0ac6385ae1ff5bf778777826da3c5edcd55b61b8/src/shared/services/model-message-converter.ts#L169-L190)。这里存储 key 也不是上游文件 ID。
- **已证实：对工具产生的图片单独限制历史回放**。只挑最近的工具结果图片重放，默认上限 5；上游支持时作为 tool image，不支持时注入后续 user image message。证据：[默认 5](https://github.com/chatboxai/chatbox/blob/0ac6385ae1ff5bf778777826da3c5edcd55b61b8/src/shared/tool-result-image.ts#L1-L8)、[图像回放 L315–355](https://github.com/chatboxai/chatbox/blob/0ac6385ae1ff5bf778777826da3c5edcd55b61b8/src/shared/services/model-message-converter.ts#L315-L355)、[选择和注入 L509–538](https://github.com/chatboxai/chatbox/blob/0ac6385ae1ff5bf778777826da3c5edcd55b61b8/src/shared/services/model-message-converter.ts#L509-L538)。**该上限针对工具结果图片，不是用户附件数量的全局限制**，L524–529 对用户内容走另一路转换。
- **已证实：有按消息数量保留最近历史的机制**：[attachment-payload.ts L56–90](https://github.com/chatboxai/chatbox/blob/0ac6385ae1ff5bf778777826da3c5edcd55b61b8/src/renderer/packages/context-management/attachment-payload.ts#L56-L90)。不应将这种历史选择理解成批量图片的独立上下文。
- **未核实**：针对用户同时添加大量图片的总字节预算与逐图独立任务自动拆分。源树存在 compaction/view-image 等模块，但本次不对所有入口、发布态做完整背书。

### Jan：接口名像上传，默认实现实际是占位——不能只看 API 名

- **已证实**：图片处理循环调用 `ingestImage`、拿 ID 并标 processed：[attachmentProcessing.ts L131–163](https://github.com/janhq/jan/blob/e0c62f863a1b930ed625085979a3d62c947635d9/web-app/src/lib/attachmentProcessing.ts#L131-L163)。但默认服务 `ingestImage` 明确是 placeholder：等待 100ms 再返回 ULID，没有上传行为：[uploads/default.ts L7–13](https://github.com/janhq/jan/blob/e0c62f863a1b930ed625085979a3d62c947635d9/web-app/src/services/uploads/default.ts#L7-L13)。因此**不能宣称 Jan 已用文件服务消除 base64**。
- **已证实**：上下文工具会按输入预算从新向旧保留消息，至少保留最新一条：[context-manager.ts L95–133](https://github.com/janhq/jan/blob/e0c62f863a1b930ed625085979a3d62c947635d9/web-app/src/lib/context-manager.ts#L95-L133)。这一模块的估算器仅遍历 text、tool parts、inline_file_contents，未计视觉图片 part：[L44–71](https://github.com/janhq/jan/blob/e0c62f863a1b930ed625085979a3d62c947635d9/web-app/src/lib/context-manager.ts#L44-L71)。这是该估算路径的限制，不足以断言全项目没有其他图像估算。
- **未核实**：所有供应商最终 wire 图片格式、是否另外使用了压缩/实际上传实现；可恢复逐图独立批处理。本次不把 Jan 当作该方案的成熟正面案例。

### ChatALL：有 stars，但“多模型并发”不能混同“多图片批处理”

- **已证实**：抽查 OpenAI 适配器继承 LangChainBot，getPastRounds 提供历史轮数限制：[OpenAIAPIBot.js L1–7、L40–42](https://github.com/sunner/ChatALL/blob/6d089c2ab72dde2ba1010cc1e910ceb766458546/src/bots/openai/OpenAIAPIBot.js#L1-L42)。基类把旧历史裁剪到 pastRounds×2，添加一个 user prompt 后 model.call：[LangChainBot.js L12–56](https://github.com/sunner/ChatALL/blob/6d089c2ab72dde2ba1010cc1e910ceb766458546/src/bots/LangChainBot.js#L12-L56)。
- **未核实**：图片存储/视觉预算/多图拆任务。在已审阅调用路径中没有这类证据。可列入筛选样本，但不推荐用它证明多图机制，也不能据此断言整个项目不支持图片。

### 给方案的直接修正

1. “图片有 ID”至少分成本地素材 ID、我们 BFF 媒体 ID、供应商文件 ID 三层。Cherry/Chatbox 表明最后仍可能转回 base64。
2. 参考 Chatbox，给历史工具图片单独设置回放窗口；保留引用，需要时重读，不能让每次看图都永久堆进模型输入。
3. 参考 Cherry，把压缩调用本身也纳入预算；只给图片占位不能称为完成视觉记忆，应保存先前确实获得的结构化结论。
4. 以上桌面客户端样本没有证实“100 图自动分拆 + 独立上下文 + 持久进度 + 按项恢复”为通用现成功能。该层需要继续看工作流/批处理项目，或明确是我们自己的产品设计。


## CLI 与浏览器客户端样本

检查日期：2026-10-01；GitHub REST repos + default-branch commit + recursive tree，再读取固定提交 raw 源码。未 clone、未 build，未运行实际服务。stars 是本次 GitHub API 快照。

| 项目 | stars | 固定 HEAD |
|---|---:|---|
| enricoros/big-AGI | 7,135 | 5954a44d2993a38f8dcf99f1d97796167af9f272 |
| sigoden/aichat | 10,478 | 82976d349ad97ac9aae0655ad631dace5e2a6385 |
| n4ze3m/page-assist | 8,239 | c54bc6f41644e83b8130532814f7b62e01a47300 |

### big-AGI

- **持久化引用不等于出站引用。** 附件可先变换尺寸/格式，再 `addDBImageAsset` 保存 DBlob，聊天片段只存 `createDMessageDataRefDBlob(...)`。[attachment.dblobs.ts L43-L99](https://github.com/enricoros/big-AGI/blob/5954a44d2993a38f8dcf99f1d97796167af9f272/src/common/attachment-drafts/attachment.dblobs.ts#L43-L99)
- **用户图片引用在请求构造时展开**：`aixConvertZyncImageAssetRefToInlineImageOrThrow(refPart, false)`；OpenAI ChatCompletions adapter 组装 `data:${part.mimeType};base64,${part.base64}`。不能宣传为上游 file ID/URL 方案。[请求构造 L314-L321](https://github.com/enricoros/big-AGI/blob/5954a44d2993a38f8dcf99f1d97796167af9f272/src/modules/aix/client/aix.client.chatGenerateRequest.ts#L314-L321)、[OpenAI 出站 L720-L730](https://github.com/enricoros/big-AGI/blob/5954a44d2993a38f8dcf99f1d97796167af9f272/src/modules/aix/server/dispatch/chatGenerate/adapters/openai.chatCompletions.ts#L720-L730)
- **可选图片预处理**：高细节、低细节、原始质量、OCR、AI caption；高低细节分别调用 `openai-high-res`、`openai-low-res`。[attachment.pipeline.ts L329-L339](https://github.com/enricoros/big-AGI/blob/5954a44d2993a38f8dcf99f1d97796167af9f272/src/common/attachment-drafts/attachment.pipeline.ts#L329-L339)、[L673-L700](https://github.com/enricoros/big-AGI/blob/5954a44d2993a38f8dcf99f1d97796167af9f272/src/common/attachment-drafts/attachment.pipeline.ts#L673-L700)
- **历史 assistant 图片降采样**：不是最近一次 assistant 消息时用 `openai-low-res`；最近 assistant 图大于 400,000 bytes 则 `openai-high-res`。范围一定要写 assistant；用户历史图此处没有相同策略。[chatGenerateRequest.ts L470-L478](https://github.com/enricoros/big-AGI/blob/5954a44d2993a38f8dcf99f1d97796167af9f272/src/modules/aix/client/aix.client.chatGenerateRequest.ts#L470-L478)
- **视觉 token 预估有独立入口**：`imageTokensForLLM(width, height, debugTitle, llm)`；存在按模型的图片估算模块。[chat.tokens.ts L35-L39](https://github.com/enricoros/big-AGI/blob/5954a44d2993a38f8dcf99f1d97796167af9f272/src/common/stores/chat/chat.tokens.ts#L35-L39)
- **批量处理边界**：本次未确认持久化逐图任务/恢复实现；README 的 Beam 是 multi-model AI validation，不能当多图批量调度证据。[README L319-L327](https://github.com/enricoros/big-AGI/blob/5954a44d2993a38f8dcf99f1d97796167af9f272/README.md#L319-L327)

### AIChat

- **本地图片直接完整读入 base64**：`File::open`、`read_to_end`、`base64_encode`、`data:{mime_type};base64,...`；此读取路径未进行缩放。媒体列表被映射为 `ImageUrl` 消息部分。[input.rs L358-L374](https://github.com/sigoden/aichat/blob/82976d349ad97ac9aae0655ad631dace5e2a6385/src/config/input.rs#L358-L374)、[L523-L539](https://github.com/sigoden/aichat/blob/82976d349ad97ac9aae0655ad631dace5e2a6385/src/config/input.rs#L523-L539)
- OpenAI adapter 直接序列化该 content 到 messages 请求体。[openai.rs L298-L310](https://github.com/sigoden/aichat/blob/82976d349ad97ac9aae0655ad631dace5e2a6385/src/client/openai.rs#L298-L310)
- **本地 token 估算器把图片计为 0**：`MessageContentPart::ImageUrl { .. } => 0`；同一估算参与 `guard_max_input_tokens`。这只说明本地预估有视觉盲区，绝不意味着上游不处理/不收费。[model.rs L247-L253](https://github.com/sigoden/aichat/blob/82976d349ad97ac9aae0655ad631dace5e2a6385/src/client/model.rs#L247-L253)、[L271-L291](https://github.com/sigoden/aichat/blob/82976d349ad97ac9aae0655ad631dace5e2a6385/src/client/model.rs#L271-L291)
- **会话压缩存在**：达到 compress threshold 可把旧 messages 移入 compressed_messages，以摘要 prompt 替换活动 messages。这是会话摘要，不是图片预算/逐图任务调度。[session.rs L320-L355](https://github.com/sigoden/aichat/blob/82976d349ad97ac9aae0655ad631dace5e2a6385/src/config/session.rs#L320-L355)
- 会话可序列化 YAML 保存。[session.rs L428-L440](https://github.com/sigoden/aichat/blob/82976d349ad97ac9aae0655ad631dace5e2a6385/src/config/session.rs#L428-L440)
- 本次未确认自动图片缩放、逐图持久化批任务、单图失败恢复等机制；不能由 CLI 易于 shell 循环推定项目已有批量系统。

### Page Assist

- **图片读取是 data URL**：`FileReader.readAsDataURL(file)`，侧栏上传处理直接调用 `toBase64`。[to-base64.ts L1-L7](https://github.com/n4ze3m/page-assist/blob/c54bc6f41644e83b8130532814f7b62e01a47300/src/libs/to-base64.ts#L1-L7)、[form.tsx L125-L139](https://github.com/n4ze3m/page-assist/blob/c54bc6f41644e83b8130532814f7b62e01a47300/src/components/Sidepanel/Chat/form.tsx#L125-L139)
- **普通聊天多图全部组装**：processedImages 格式化为 `data:image...`，随后 `imagesToUse.forEach` 追加 `image_url`。[normalChatMode.ts L157-L168](https://github.com/n4ze3m/page-assist/blob/c54bc6f41644e83b8130532814f7b62e01a47300/src/hooks/chat-modes/normalChatMode.ts#L157-L168)、[L236-L260](https://github.com/n4ze3m/page-assist/blob/c54bc6f41644e83b8130532814f7b62e01a47300/src/hooks/chat-modes/normalChatMode.ts#L236-L260)
- **历史重放包含图片**：generateHistory 遍历传入 messages，再遍历每条 messages.images，重建全部 image_url；本函数未见按视觉预算裁剪。因此只能说本条普通聊天路径仍重放图片，不能推定所有 provider 没其他限制。[generate-history.ts L56-L115](https://github.com/n4ze3m/page-assist/blob/c54bc6f41644e83b8130532814f7b62e01a47300/src/utils/generate-history.ts#L56-L115)
- **历史保存含 images 字符串数组**，普通聊天结束保存 imagesToSave。[normalChatMode.ts L384-L410](https://github.com/n4ze3m/page-assist/blob/c54bc6f41644e83b8130532814f7b62e01a47300/src/hooks/chat-modes/normalChatMode.ts#L384-L410)
- **确有队列，但不是我们的批任务**：`useMessageQueue` 用 React.useState/useRef 维护排队聊天消息，streaming 结束后 onSendMessage 下一条；不是持久化逐图片任务系统。[useMessageQueue.ts L13-L85](https://github.com/n4ze3m/page-assist/blob/c54bc6f41644e83b8130532814f7b62e01a47300/src/hooks/useMessageQueue.ts#L13-L85)
- 本次普通聊天路径未确认自动图片缩放、视觉 token 预算/历史图剔除或持久化批任务。src/utils/compress.ts 是文本 gzip，不能拿来声称图片压缩。

### 对方案的直接启示

1. 高 stars 不代表已解决大量图片；三者均存在常规链路最终携带 base64 的证据。
2. 需要分清本地/自有服务的资产 ID，与模型供应商实际接收的表示；引用存储不自动缩减模型请求。
3. 可借鉴 big-AGI 的图片质量选项、历史 assistant 图降采样，但我们需针对工具图/用户图做有语义的保留策略。
4. 必须单独测视觉预算；AIChat 的例子说明“有 token guard、有摘要”不保证图片场景安全。
5. 三者中未确认可以直接照搬的持久化逐图批处理闭环；Beam 与排队聊天都不能冒充这种闭环。


## 角色聊天与 Agent 样本

调查日期：2026-10-01。stars 来自本轮 GitHub REST `GET /repos/{owner}/{repo}`，只读源码抽样，未运行测试或复现。固定默认分支提交，不把 open PR 当已实现。源码缓存 `/tmp/image-research-niche`。

| 项目 | stars | 固定 commit |
|---|---:|---|
| SillyTavern/SillyTavern | 33,990 | 06bde939fb1e9c4c8d8641d810f0a916b5bce127 |
| AstrBotDevs/AstrBot | 41,274 | 553b10fa35345052ffa1030d3fd7fb537944cb99 |
| iOfficeAI/AionUi | 33,263 | 6744099b279b991c17e31c243f0920477bd31cb6 |
| agentscope-ai/CoPaw | 35,397 | 80e412da9b5505bcac5eec6add271d09fa144c60 |

### SillyTavern：本地图片引用，出站仍 base64；图片预算已纳入历史选择

- 上传循环把文件转 base64、调用 `saveBase64AsFile`，消息 `extra.media` 存 url/type/title；后端写入用户图片目录，返回相对路径。[chats.js 205–227](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/chats.js#L205-L227)、[images.js 64–74](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/images.js#L64-L74)。
- 模型输入 `addImage` 对非 data URL fetch 后转 base64，再压缩，以 `image_url.url` 携带 data URL。不能把字段名 image_url 等同于远端 URL。[openai.js 3624–3650](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L3624-L3650)。
- 对 OpenRouter/Gemini/Mistral/Vertex 等来源，超过 2 MiB 的图生成最长边 2048 的缩略图；视觉 token 按 quality/尺寸估算。此算法参考特定 OpenAI 视觉模型，不代表所有模型估算准确。[openai.js 3725–3770](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L3725-L3770)。
- 历史图片进入 `addImage` 后，整条消息接受 `canAfford` 检查，预算不足停止添加更老历史。[openai.js 962–975](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L962-L975)、[1070–1074](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L1070-L1074)。
- 边界：本次没有核实可靠多图独立任务队列；不应声称没有插件能做，也不应将普通聊天预算裁剪描述为批处理引擎。

### AstrBot：仍内联历史图片；token 预算与内存字节预算是两回事

- OpenAI provider 将图片引用解码为 base64 data URL，生成 `image_url` 内容块。[openai_source.py 180–210](https://github.com/AstrBotDevs/AstrBot/blob/553b10fa35345052ffa1030d3fd7fb537944cb99/astrbot/core/provider/sources/openai_source.py#L180-L210)。
- `ProviderRequest.assemble_context` 也把引用展开为 data URI。[entities.py 220–275](https://github.com/AstrBotDevs/AstrBot/blob/553b10fa35345052ffa1030d3fd7fb537944cb99/astrbot/core/provider/entities.py#L220-L275)。
- token 估算每张图片固定 765；不会按 base64 字节数计数。[token_counter.py 31–35](https://github.com/AstrBotDevs/AstrBot/blob/553b10fa35345052ffa1030d3fd7fb537944cb99/astrbot/core/agent/context/token_counter.py#L31-L35)、[61–75](https://github.com/AstrBotDevs/AstrBot/blob/553b10fa35345052ffa1030d3fd7fb537944cb99/astrbot/core/agent/context/token_counter.py#L61-L75)。
- context manager 支持按轮裁剪及达到 token 阈值时摘要，摘要后仍超预算再减半截断。[manager.py 58–76](https://github.com/AstrBotDevs/AstrBot/blob/553b10fa35345052ffa1030d3fd7fb537944cb99/astrbot/core/agent/context/manager.py#L58-L76)、[112–122](https://github.com/AstrBotDevs/AstrBot/blob/553b10fa35345052ffa1030d3fd7fb537944cb99/astrbot/core/agent/context/manager.py#L112-L122)。
- 实际故障报告：[issue #10092](https://github.com/AstrBotDevs/AstrBot/issues/10092)，2026-09-15 建立、本轮仍 open。用户报告 v4.28.1 多轮大图导致本机 MemoryError，后续纯文本也失败。该报告支持“字节体积和视觉 token 要分别治理”的设计动机，但本轮未复现，不将报告所有因果当已验证事实。
- 此 issue 的官方 timeline 链接 [#10185 字节预算 PR](https://github.com/AstrBotDevs/AstrBot/pull/10185)（open，未合并）、[#10210 持久引用/按需回看 PR](https://github.com/AstrBotDevs/AstrBot/pull/10210)（closed，未合并）、[#10259 持久图库/原生视觉历史 PR](https://github.com/AstrBotDevs/AstrBot/pull/10259)（open，未合并；head `4821436253c1e9f3e119c6bc4b827d26fc9f42a9`）。最后一项 PR 描述明确区分“持久化历史无 base64”与“prepared request 仍带 base64”，并且不实现 provider Files API；只是提案证据，不是当前主分支能力。

### CoPaw：单媒体字节上限、上下文占位与付费异步任务恢复

注意：此仓库当前源码命名已用 `qwenpaw`，应按仓库身份称 CoPaw/QwenPaw，别忽略改名导致路径变化。

- 本地图片在 `freeze_image_bytes` 校验格式、限制体积后生成不可变 Base64Source；核心 agent 调用 `freeze_local_images_async`。[image_freezing.py 87–148](https://github.com/agentscope-ai/CoPaw/blob/80e412da9b5505bcac5eec6add271d09fa144c60/src/qwenpaw/agents/utils/image_freezing.py#L87-L148)、[react_agent.py 661](https://github.com/agentscope-ai/CoPaw/blob/80e412da9b5505bcac5eec6add271d09fa144c60/src/qwenpaw/agents/react_agent.py#L661)。
- formatter 默认单媒体上限 2 MiB，超限时在出站上下文替换文本占位，而非把原媒体删出持久历史/UI。支持 OpenAI/Anthropic/Gemini/DashScope 的相应 formatter。[capping_formatter.py 1–16](https://github.com/agentscope-ai/CoPaw/blob/80e412da9b5505bcac5eec6add271d09fa144c60/src/qwenpaw/providers/capping_formatter.py#L1-L16)、[53](https://github.com/agentscope-ai/CoPaw/blob/80e412da9b5505bcac5eec6add271d09fa144c60/src/qwenpaw/providers/capping_formatter.py#L53)、[85–118](https://github.com/agentscope-ai/CoPaw/blob/80e412da9b5505bcac5eec6add271d09fa144c60/src/qwenpaw/providers/capping_formatter.py#L85-L118)。这是单媒体保护，不证明有总请求字节预算。
- 可配置请求时像素缩放，但环境变量未设置/为零时禁用，不能报告为默认压缩。[image_resize.py 30–51](https://github.com/agentscope-ai/CoPaw/blob/80e412da9b5505bcac5eec6add271d09fa144c60/src/qwenpaw/utils/image_resize.py#L30-L51)。
- **独立 creator 插件**有图像任务持久记录、idempotency key、成功结果 replay，运行中防止另一执行者重复领取。[image_execution.py 1849–1907](https://github.com/agentscope-ai/CoPaw/blob/80e412da9b5505bcac5eec6add271d09fa144c60/plugins/apps/qwenpaw-creator/backend/services/media_files/image_execution.py#L1849-L1907)。
- 已被上游接受的付费异步任务发生本地断联/轮询超时，会继续保持 RUNNING 并交给恢复 supervisor；只有已实现恢复的 provider task 类型允许这样做。按 task id 避免重复后台监督。[image_execution.py 2194–2262](https://github.com/agentscope-ai/CoPaw/blob/80e412da9b5505bcac5eec6add271d09fa144c60/plugins/apps/qwenpaw-creator/backend/services/media_files/image_execution.py#L2194-L2262)。
- 边界：这是很相关的收费图片任务恢复实现；没有核实其“100 张附件 → 自动分配独立视觉上下文 → 聚合结果”的完整聊天闭环，不要声称它已经具备我们的整套方案。

### AionUi：有限补充样本，不能夸大覆盖面

仅核实兼容适配器：OpenAI image_url 转 Gemini inlineData；遇到 HTTP image URL 明确抛错、要求 base64 data URL。[OpenAI2GeminiConverter.ts 128–149](https://github.com/iOfficeAI/AionUi/blob/6744099b279b991c17e31c243f0920477bd31cb6/packages/desktop/src/common/api/OpenAI2GeminiConverter.ts#L128-L149)。
这是“同一个产品里 provider 适配路径会约束传输形式”的证据，不能以单个适配器推断整个 AionUi 附件架构、历史管理或所有 agent 后端。未核实完整批量闭环。

### 对方案的含义（推论）

1. 普遍不能将“消灭 base64”作为目标；文件/素材引用适合内部存储，但兼容层可能最后仍需要 base64。
2. 优先建立内部媒体引用、请求时解析、预览及明确的总字节预算；视觉 token 是另一条预算，不能混为一谈。
3. 占位删图必须让模型和用户知道，否则会静默失去重要输入。回看机制比永久丢弃更合适。
4. 独立批处理是业务执行层能力，不能因为聊天 UI 支持多图就假定具备；付费图片任务恢复尤其应参考 accepted provider job 的状态，不直接重发。
