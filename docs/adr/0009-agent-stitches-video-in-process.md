# ADR 0009：多段视频在 BFF 进程里用 ffmpeg 拼成一条，成片是一件普通视频产物

- 状态：实施中
- 关联：`docs/research/video-workflow-trace.md` §〇 §十六、[ADR 0003](./0003-agent-runtime-in-bff-process.md)、[ADR 0007](./0007-agent-skills-progressive-loading.md)

视频轮已经能逐镜出首帧、逐镜出片，唯独出不了一条完整的片子——四条视频技能的正文里都写着
「这几段需要你自己接成一条」。竞品（即梦）在各镜出完后自己把它们接起来，且不额外收费。
这条 ADR 说的是我们怎么补上这一段。

## 决定

### 1. 已完成的视频产物进模型可指代的集合，但字节不进模型

`AgentImageSource` 多一条**并列的视频出口** `resolveVideo(videoId)`：历史与本轮的工具结果块
照旧走同一次遍历，`media === 'image'` 的进图片表（可以取出位图给模型看），
`media === 'video'` 的进视频表（只留任务 id 与产出下标，给工具去取字节）。
`rememberImages()` 跳过视频这条规则没有松动——松动了模型就会拿一段 mp4 去调改图。

「模型说的 id → 对象引用」仍然只有 `AgentImageSource` 这一个出口，只是它现在回答两种介质。
查不到与查得到但不可用分开回答（`unknown` / `unavailable`），工具据此写不同的回执，
不抛错、不让整轮死掉。

历史重放不需要改：`agentToolResultSummary` 本来就按 `AGENT_ARTIFACT_NOUN[media]` 把
「视频 agent_xxx」写进摘要，所以下一轮模型手上仍有那几段的 id。这条已经成立的性质由测试钉住，
免得哪天有人把回放改成只列图片。

### 2. 拼接在 BFF 进程里跑 ffmpeg，不进队列 worker

队列 worker 的每一条不变量都是为「调上游、可能要钱、可能要重试、可能要退款」写的：
claim → in_progress → 上游 fetch → 归档 → finishTask → 私有 overlay 结算。拼接一件上游都不碰，
把它塞进去就得为它伪造一个 provider、一条不存在的上游调用，还要让结算 hook 认得
「这条不要钱」。反过来，智能体工具本来就在轮里异步跑、有 `onUpdate` 报进度、有 `signal` 可取消，
ffmpeg 是一次本机子进程调用——它长得就像工具，不像队列任务。所以 `stitchVideos.execute()`
直接 `Bun.spawn` 调 ffmpeg/ffprobe，与 ADR 0003「轮就在 API 进程里跑」是同一条线。

代价写在明处：进程被杀时这一轮的拼接就没了（与整轮一样，见 ADR 0003），临时文件由
`finally` 清理，孤儿目录在系统临时目录里由 OS 收。

### 3. 默认统一参数重编码，分辨率取第一段，画幅不同的段补边

不同模型出的片编码、分辨率、帧率、有没有音轨都可能不同，`-c copy` 只在所有参数完全一致时才成立，
不一致时它不会报错，只会产出一条播放器各家表现不同的坏片。所以默认一律重编码：
逐段 `scale` + `pad` 到第一段的分辨率、`fps` 归一、`setsar=1`，
再用 `concat` 滤镜接起来，`libx264` + `yuv420p` 输出。

**画幅不同的段补边（letterbox / pillarbox），不拒绝。** 拒绝意味着让用户为一次免费的拼接
重新花钱出片；补边至少把已经付过钱的那几段留下了。但补边这件事必须说出口——工具回执逐段写清
「哪一段被补了边、原本是什么画幅」，模型据此可以建议重出那一镜。

**音轨按需补。** 一段都没有音轨时输出就没有音轨；只要有一段有，其余段补等长静音轨
（`anullsrc` 一路输入 + `atrim`），否则 `concat` 滤镜会因为输入流数不齐而失败。

参数怎么拼是纯函数（`video-stitch-plan.ts` 的 `stitchTarget` / `stitchFilterGraph` /
`stitchFfmpegArgs`），单测只测它，不启动 ffmpeg；另有一条「本机装了 ffmpeg 才跑」的
集成测试拿真二进制把滤镜图跑通一次。

### 4. 成片是一条出生即 `completed` 的任务行，走 generateVideo 同一条交付链路

画布、结果卡与播放器都按 `AgentToolArtifact` 的 `{ taskId, outputIndex }` 去
`/v1/queue/requests/:id/output/:index` 取字节。要让成片「和别的视频一模一样」，
最省的做法就是给它一条任务行：`provider: openai-compat`、`model: ffmpeg-concat`、
`status: 'completed'`、`result_payload.data[0].object` 指向对象存储里那份 mp4、
`request_payload.video` 带上成片的时长与画幅。于是：

- 前端零改动，Range 播放、封面、点卡定位画布全都照旧。
- 保留期与清理跟着 `purgeOldTasks` 走，与生视频产物同一套。
- `publishGenerations` 里那条 `request_payload -> 'video' IS NULL` 让视频不进
  `generation_records`，成片带着 `video` 字段，与逐镜产出一致——「该进作品/历史的地方照进」
  在视频这条线上本来就是「不进」，这里不为它破例。

**封面不在服务端抽帧。** 前端 `captureVideoPoster()` 已经从视频本身抓首帧当封面
（抓不到退深色底），生视频产物走的就是这条路。服务端再用 ffmpeg 抽一帧、再多存一个对象，
既没有消费者也多一份要清理的东西。真要服务端封面，那是整条视频链路一起改的事，不是拼接的事。

### 5. 不扣积分，而且根本不进记账

任务行**出生即终态**：不经 `createQueueTask`，所以 `reserveTask` 不会被调用；
不经 `finishTask` / `cancelTasks`（两者都只改 `queued` / `in_progress` 的行），
所以 `finalizeTask` 也不会被调用。私有计费 overlay 的账本里因此没有这条任务的任何痕迹，
`taskCredits` 查不到它——这正是「0 积分」的准确含义，而不是「预扣 0 再结算 0」。

这样对私有 overlay 是安全的，因为它的两个 hook 都是**被公开树在事务里显式调用**的，
没有「凡是 tasks 行都必须有账本行」的反向依赖：退款走 `finalizeTask(outcome)`，
而一条从未预扣、也从未转终态的行不会走到那里。公开树这次不新增任何对 `private/` 的引用。

上游一次都没调，所以 `upstream_invocation_count` 保持 0；运营后台看到的就是一条
「模型 ffmpeg-concat、零上游调用、零积分」的任务，如实。

### 6. 门禁三重，缺一不出现在清单里

`stitchVideos` 只在 **视频轮**（`modes: ['video']`）、**`generation:video` 开着**、
**且启动时探测到 ffmpeg** 时才进工具清单。探测在 BFF 启动时做一次（`agent.ffmpeg_ready` /
`agent.ffmpeg_missing` 日志），不每轮探一次：每轮 spawn 一个进程只为问「你在吗」，
在小机器上是纯浪费。没探测过就是「不可用」，所以任何没跑启动探测的进程（测试、脚本）
都不会意外把这个工具发给模型。

技能正文里那句「拼接做不到」因此改成「各镜出完后在同一轮里调 `stitchVideos` 交付成片；
工具不在清单里时才退回说明做不到」。

### 7. 一台小机器同一时刻只拼一条

VPS 的 CPU 是共享的，两条 1080p 重编码同时跑会把整个 BFF 的响应拖垮。所以全局一个槽：
正在拼的时候，后面那次进队等（结果卡显示「已排队」，复用现有的 `submitted` 阶段，
前端与 i18n 零改动）；等的人再多就直接回执「现在排不下，稍后再试」，不无限堆。

上限：最多 8 段、总时长 180 秒、单次 ffmpeg 300 秒超时。触到上限不是异常，是一条
写明白的回执。临时目录 `mkdtemp` 一次、`finally` 删一次，成功、失败、超时、取消四条路
共用那一个 `finally`。

## Considered Options

- **走队列 worker**：拼接伪装成一条队列任务，由 worker 跑 ffmpeg。好处是重启后能接着跑、
  和生图生视频同一套状态机；代价是要给它编一个 provider 与一次不存在的上游调用，
  还要让预扣结算认得「这条不要钱」——把计费路径为一件不花钱的事改开，风险远大于收益。否决。
- **`-c copy` 快拼，参数不一致时再回退重编码**：省 CPU，但「参数一致」要先探明每一段，
  探完之后省下的那点时间还不够两条代码路径的维护成本，而且不一致时 `-c copy` 的坏片是
  静默的。否决。
- **画幅不同直接拒绝**：与「用户明说的约束不许静默丢掉」同源，但这里被拒绝的是一次
  **不花钱**的操作，而重出一镜是花钱的。补边 + 如实说明更省用户的钱。否决。
- **在前端用 WebCodecs / ffmpeg.wasm 拼**：不占服务器 CPU，但成片落不进对象存储、
  进不了跨设备恢复，几百 MB 的 wasm 还要进首屏预算。否决。
- **在 BFF 进程里跑 ffmpeg，成片落成一条出生即完成的任务行。** 采纳。

## Consequences

镜像多一个系统依赖：runtime stage 装 `ffmpeg`（apt，`--no-install-recommends`）。
本机没装 ffmpeg 时这个工具自动不出现，开发照常。测试一律走可注入的执行接缝
（`setFfmpegForTesting`），不依赖宿主机真有 ffmpeg；另有一条「有 ffmpeg 才跑」的集成测试，
默认跳过。

`AgentToolName` 多了一个 `stitchVideos`。前端不为它分支：它渲染成一张普通工具卡，
标题由服务端在起跑时写好，产物走既有的视频交付链路。

工具清单多一条，每一轮的系统提示词与预扣估算跟着涨一点，但**只涨在视频轮**：
实测（`agent-video-operator-config.json` + 一条短提示词）一条视频轮的输入估算从 2800
涨到 3098 token，其中 179 来自工具声明、119 来自系统提示词里那句逐工具指引。
图片轮一个 token 都没动，所以 `agent-billing.test.ts` 那两条 `unitMultiplier` 区间不用改
——它们断言的是图片轮。视频轮没有对应的预扣断言，这条增量因此没有测试守着；
真要守，该加的是一条视频轮的预扣用例，而不是把这两条改成视频。

模型现在能指着一段已完成的视频说话了。这条能力目前只有拼接在用，但它是「视频当输入」
这一类工具（续写、配乐、加字幕）共同的地基。
