# 对话模型怎么读视频（2026-10-12）

调研日期：**2026-10-12**。只读 OpenAI、Anthropic、Google 官方文档与各自 API reference。未改实现。打不开的页不补写。两套 Gemini 计费数字互相矛盾，原文照录，不折中。

问题：Chat Completions / Responses、Claude Messages 收不收 mp4；只收图片时官方让不让抽帧、抽多少、要不要时间戳和转写。Gemini 原生视频的默认 FPS、时长、音轨、上传方式和计费口径。三家里谁是模型自己看视频。抽帧上限和成本警告。

---

## OpenAI

当前视觉指南只列图片。Chat Completions 用来分析图片并生成文字；Responses 用来分析图片，或用生图工具出图。输入方式是图片 URL、base64 data URL，或 Files API 的 file ID。文件类型只有 PNG、JPEG、WEBP、非动画 GIF。单次请求合计最多 512 MB、最多 1,500 张。图片按 token 计费，还要和其余 prompt 一起塞进模型上下文；token 估算不保证请求一定合法。（<https://developers.openai.com/api/docs/guides/images-vision>，2026-10-12）

Chat Completions 的 user content 是文本、`image_url`、`input_audio`，或 `file`。`input_audio.format` 只有 `wav` 和 `mp3`。`file` 只接受 PDF。（<https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create>，<https://developers.openai.com/api/docs/guides/file-inputs>，2026-10-12）

Responses 的 `input_file` 接受 PDF、文本/代码、Office 文档、演示文稿、表格。该页的扩展名与 MIME 表里没有 `video/mp4` 或其他视频类型。非 PDF 文件只抽文本，不抽嵌入图片。音频对话指南写明：Responses 文档目前描述的是文本和图片输入、文本输出；要在对话里收发音频，用 Chat Completions 加音频模型。（<https://developers.openai.com/api/docs/guides/file-inputs>，<https://developers.openai.com/api/docs/guides/audio-chat-completions>，2026-10-12）

**结论：这两套对话 API 都不把 mp4 当模型的视觉输入。** 现行视觉指南没有抽帧间隔、张数、时间戳或分辨率的推荐。`detail` 管的是单张图片：`low` / `high` / `original` / `auto`。部分模型上 `low` 并不比 `high` 更省 token。（同上，images-vision）

音轨不在视觉请求里。转写是另一条 API：`/v1/audio/transcriptions`，推荐模型 `gpt-transcribe`。文件最大 25 MB，格式含 `mp3`、`mp4`、`mpeg`、`mpga`、`m4a`、`wav`、`webm`。这是把录音转成文字，该页没有说会读画面。更长的录音要压缩或切成不超过 25 MB 的块，且不要从句子中间切开。（<https://developers.openai.com/api/docs/guides/speech-to-text>，2026-10-12）

归档 Cookbook 才写了「不能直接送视频」：

- 2024-07-18，页首标明 archived。原文：不能直接把视频送给 API；抽帧当图片。示例函数默认每 2 秒一帧，笔记本实际用每 1 秒一帧，并写「可改 `seconds_per_frame`」。帧以 `detail: "low"` 送入，提示词只有 “These are the frames from the video.”，没有逐帧时间戳。音轨另存成 mp3，交给当时的 `gpt-4o-audio-preview` 转写，再把转写文本和帧放进同一次请求。该篇同时写：只有画面会漏掉讲话，只有转写会漏掉画面。（<https://developers.openai.com/cookbook/examples/gpt4o/introduction_to_gpt4o>）
- 2025-04-22，页首标明 archived。原文：GPT-4.1-mini 不直接收视频；不必把每一帧都送进去。示例是解码后每 25 帧取 1 帧，当 `input_image`。笔记没写源视频 FPS，不能换成秒间隔。提示词不带时间戳，也不处理音轨。（<https://developers.openai.com/cookbook/examples/gpt_with_vision_for_video_understanding>）

这两篇是归档示例，不是 2026 年视觉指南里的规范。

## Anthropic

Messages API 的说明是：发送带文本和/或图片的消息。`image` 的 `media_type` 只有 `image/jpeg`、`image/png`、`image/gif`、`image/webp`。document 是 PDF 或纯文本。2026-10-12 在 Messages reference 里搜 `video` / `mp4`，没有视频 content block，也没有 `video/mp4`。（<https://platform.claude.com/docs/en/api/messages>，<https://platform.claude.com/docs/en/build-with-claude/working-with-messages>）

视觉指南：多图可以一起看，例子是对比或文档页序。多图时用 `Image 1:`、`Image 2:` 这类短标签。API 张数上限：200k 上下文的模型每请求 100 张，其余模型 600 张；claude.ai 每条消息 20 张。单张最大 8000×8000 px；**一个请求里超过 20 张图（含历史轮次重发的图）时，每张边长不得超过 2000 px**，否则 `invalid_request_error`。直连 API 时单张 base64 最大 10 MB，Bedrock / Google Cloud 为 5 MB。GIF 等动画不支持，只用第一帧。计费按 28×28 像素的 visual token。高分辨率档（Claude 4.7 及以后）单张最多 4784 visual token，约为标准档上限的三倍；不需要那点清晰度时，官方建议先缩小再送，以控制成本和延迟。（<https://platform.claude.com/docs/en/build-with-claude/vision>，2026-10-12）

**未查到** Claude 官方的「把一段视频交给模型」指南，也未查到抽帧间隔、时间戳或单独转写的官方做法。上面的多图标签是文档页/对比图的写法，指南没有说它用于视频帧。

## Google Gemini / Vertex

模型收的是视频，不是调用方抽好的帧。开发者文档（Interactions API，页末更新 2026-10-09）写：能描述、切段、提问，并能指向视频内时间点。音画两路都进模型。（<https://ai.google.dev/gemini-api/docs/video-understanding>）

输入方式，同一页：

| 方式 | 该页写的限制 |
| --- | --- |
| File API | 付费 20 GB / 免费 2 GB；大文件、长视频、要复用时用 |
| Cloud Storage 注册 | 单文件 2 GB |
| Inline | 表内写 &lt; 100 MB，且适合短于 1 分钟的一次性输入 |
| YouTube URL | 公开视频。免费层每天最多 8 小时；付费层不按视频长度设限。2.5 以前每请求 1 条，2.5 及以后最多 10 条 |

同一页正文又写：inline 适合总请求小于 20 MB 的短视频；总请求大于 20 MB、时长很长、或要多次提问时，必须用 File API。**100 MB 与 20 MB 都在这一页上，未再查到哪条覆盖哪条。** generateContent 页标题现为 Legacy，技术细节与上页一致，inline 同样是「表内 &lt; 100 MB / 正文 &lt; 20 MB」。（<https://ai.google.dev/gemini-api/docs/generate-content/video-understanding>，2026-10-12）

MIME：`video/mp4`、`video/mpeg`、`video/mov`、`video/avi`、`video/x-flv`、`video/mpg`、`video/webm`、`video/wmv`、`video/3gpp`。

默认采样与音轨（开发者文档 Technical details）：

- 默认 **static**：所有模型都是 1 FPS 抽帧放进上下文。音频按 1 Kbps、单声道处理。每秒加时间戳。快动作会因 1 FPS 丢细节。
- 1M 上下文的模型：低媒体分辨率默认可到 3 小时，高媒体分辨率可到 1 小时。
- 自定义 `fps`、以及 `start_offset` / `end_offset`，只在 static 模式可用。示例是 `fps: 0.5`（每 2 秒 1 帧）。Legacy 页另写：长视频、尤其是讲座这类几乎静止的片子，把 FPS 调到 1 以下；要细看时间的快动作再调高。该页示例有 `fps: 5`。
- 提问里的时间点用 `MM:SS`。单视频时，文字放在视频 part 之后。
- **Agentic**（Gemini 3.8 Flash、3.6 Flash、3.5 Flash Lite）：模型自己沿时间轴走，按需加载转写、帧和/或音频，而不是整段铺进上下文。长视频可少用最多约 88% 的 token；短于 5 分钟的片子可能因为内部推理和工具往返，首 token 更慢。官方建议长视频或「问某一刻」优先 agentic；5 分钟以内、要低延迟、或要整段逐帧时用 static。

计费口径是 **token，不是单独的按帧价或按时长价**。static 在开发者文档里按「每秒」拆开：1 FPS 下，`media_resolution=low` 为 66 token/帧，否则 258 token/帧；音频 32 token/秒；另有元数据。合计大约低分辨率 100 token/秒、高分辨率 300 token/秒。因为默认 1 FPS，帧数等于秒数，所以这笔费用同时随时长和分辨率涨。调高 `fps` 会增加帧 token。Agentic 不按整段时长铺满：导航推理算 thought token，按需加载的帧、音频、转写算 tool-use token。

**同一厂商另一页的数字不同，不要混用。** Media resolution（页末更新 2026-09-23）对 Gemini 3 写：视频默认 / low / medium 都是 70 token/帧，high 是 280 token/帧；音频在各分辨率下都是 25 token/秒。并写明 `media_resolution` 管每帧 token 数，`processing` 管哪些内容进上下文，两者可同时设。（<https://ai.google.dev/gemini-api/docs/media-resolution>）

Vertex / Gemini Enterprise Agent Platform（页末更新 2026-10-10）是另一套时长表，不是上面的「3 小时」：同一张表里，3.8 / 3.7 / 3.6 / 3.5 / 3.1 Flash-Lite / 2.5 系列约为带音频 45 分钟、无音频 1 小时，每 prompt 最多 10 条视频；Gemini 3.1 Pro 与 Gemini 3 Flash 同样是约 45 分钟 / 1 小时，并写默认 70 token/帧。该页 tokenization：Gemini 3 默认 70 token/帧，high 280，low 与 medium 也是 70；**Gemini 3 以前**才是默认 258、低分辨率 66。这能对上「66/258」和「70/280」为什么同时存在，但开发者视频页的 Technical details 没有按代分开写。（<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding>）

Vertex 同一页还写：File API 处理时 1 FPS、音频 1 Kbps 单声道、每秒加时间戳，并声明这组速率以后可能改。采样 ≤1 FPS 时，提示里的时间用 `MM:SS`（超过 1 小时用 `H:MM:SS`）；高于 1 FPS 时用 `MM:SS.sss`。最佳实践写「一个 prompt 只用一条视频效果最好」，与上面「最多 10 条」同页并存。快动作会因 1 FPS 丢细节，该页的建议是把片子放慢，而不是只提高 FPS；Gemini 3 的另一条则是快动作提高 FPS。非语音的声音可能认错。

## 只能走图片视觉时，有出处的做法

三家里，**Gemini 是模型自己看视频**（调用方交 mp4 / YouTube / inline，服务端抽帧并处理音轨）。**OpenAI 的 Chat Completions 与 Responses、Anthropic Messages 都是调用方先变成图片再送。** 现行 API 指南里，把这件事写成步骤的只有 OpenAI 两篇归档 Cookbook。

有出处的只有这些：

- 均匀抽帧，不当视频文件送。一篇示例是每 1 秒 1 帧（代码默认每 2 秒），另一篇是每 25 个解码帧取 1 帧。两篇都写明不必每帧都送。没有官方的「固定 N 帧」。（上节两篇 Cookbook）
- 帧旁加一句 “these are frames from the video”。这两篇都**没有**逐帧时间戳。
- 要听讲话，就把音轨分开转写，再把文本和帧放进同一次请求。只送帧会漏掉说话内容。现行转写 API 接受 mp4 作为录音文件，上限 25 MB；这不等于对话模型在看画面。（Cookbook 2024-07-18；speech-to-text 指南）
- 2024 年那篇把帧的 `detail` 设为 `low`。2026 年视觉指南不再把 `low` 一律当成更便宜，部分模型上它的 token 反而更多。
- Claude 的多图短标签、以及「超过 20 张就把边长压到 2000 px 以内」，是图片请求的规则，不是视频抽帧规范。

**未查到**：三家任一官方文档要求首帧+尾帧、场景切分，或规定对话 Agent 应该抽几帧。也未查到 Claude 的视频抽帧或转写步骤。Gemini 的 1 FPS、每秒时间戳、长片降低 FPS、快动作提高 FPS，是原生视频管线里服务端的做法，不是「调用方抽帧再当图片送」的规范。

## 张数上限和成本警告

| 来源 | 上限 | 成本/上下文警告 |
| --- | --- | --- |
| OpenAI 视觉指南 | 每请求 1,500 张图片；合计 512 MB。单图处理后超过 30,000 patch 会拒绝，不自动缩小 | 图片即 token，必须连同其余 prompt 放进上下文。`detail` 和模型决定 patch 数。没有「视频最多 N 帧」的另条 |
| Claude 视觉指南 | 200k 模型每请求 100 张；其他模型 600 张。超过 20 张时每张边长 ≤2000 px，否则拒绝。单张 8000×8000 px；直连 API 单张 base64 ≤10 MB | 按 visual token 计。高分辨率最多约 3 倍 token。不需要细节就先缩小。动画只用第一帧，不能靠 GIF 交视频 |
| Gemini 开发者视频页 | 未单列「最多 N 帧」。1M 上下文：低分辨率约 3 小时，高分辨率约 1 小时。每请求视频条数：2.5 以前 1 条，之后最多 10 条 | static 约 100 或 300 token/秒（与 media-resolution、Vertex 的 70/280 冲突，见上）。1 FPS 漏快动作。长视频用 agentic 或降低 FPS，避免塞满上下文。长请求用流式或 background，否则可能 401 或超时 |
| Vertex 视频页 | 按模型，约 45 分钟（带音频）或 1 小时（无音频），多数模型每 prompt 10 条。未单列帧数上限 | Gemini 3 默认 70 token/帧，high 280。File API 的 1 FPS / 1 Kbps「以后可能改」。一 prompt 一条视频是同页的效果建议，不是硬上限 |

## 未查到

- OpenAI、Anthropic 现行 API 指南里的抽帧间隔、推荐张数、逐帧时间戳格式、抽帧分辨率。
- 场景切分、首尾帧，作为任一厂商的官方做法。
- Claude Messages 接受 `video/mp4` 的说明，以及官方视频理解指南。
- 一份能同时盖过 Gemini 开发者视频页（66/258 与 32 token 音频）和 media-resolution / Vertex（Gemini 3 为 70/280 与 25 token 音频）的统一计费页。两套数字都以各自页面原文为准。
- Inline 视频究竟以 20 MB 还是 100 MB 为限。同一官方页两处都写了。

## 本仓库怎么用

对话链路只收图片（OpenAI 兼容，没有视频 content block）。`viewVideo` 对一条本会话已完成的视频产物按时间抽静帧：能按 1 秒一帧放下时就按 1 秒，最多 8 帧；更长则均匀取 8 帧并标明间隔。每帧带 `t=` 秒，长边缩到 1024。回执写明这是静帧、两帧之间的运动没看到、音轨没听到。一次一段。唤醒轮不自动抽帧，只指到 `viewVideo`。界面标题是「看视频」。抽帧用运行镜像里的 ffmpeg，只出几张缩小的 JPEG，不在服务端重编码成片（ADR 0010）。
