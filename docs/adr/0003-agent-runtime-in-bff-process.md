# 智能体运行时用 pi 当库跑在 BFF 进程里，不上独立 agent 服务

智能体模式需要工具循环、逐字流式、按 token 预扣结算、服务端会话与上下文压缩。我们把
`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 当库跑在 BFF 进程里，会话、消息与流事件
落现有 PostgreSQL，前端的 SSE 线协议与消息状态机由我们自己写；不部署独立 agent 服务，也不引入 Redis。

这么定有三条理由。**预扣结算必须与业务写在同一事务里**：`reserveTask` / `finalizeTask` 是事务内 hook，
自带连接池、自建表的第三方存储层（LangGraph 的 checkpointer、Mastra 的存储）都做不到；pi 的会话后端
可插拔，我们写一个 Postgres 后端即可。**断线重连不需要跨进程转发**：对话轮就在 API 进程里跑，事件同
进程，一张 Postgres 事件表加 `Last-Event-ID` 重放就够；公司内部的 agent-server 要 Redis 是因为它把 run
放在 worker 进程，我们没有这个结构。**产品的三根骨头在 pi 里是接缝而不是缝补**：`transformContext` 是
上下文压缩的挂点，工具 `execute` 的 `onUpdate` 把分钟级生图生视频的进度推出去，`steer()` 支持用户在一轮
跑着的时候插话。

## Considered Options

- **部署公司内部的 agent-server（Python + LangGraph）作独立服务。** 对话运行时最完整，但积分与我们的
  四个工具它都没有，Tier 2 部署从两个容器变四个，仓库归属公司组织。否决。
- **Vercel AI SDK 当库。** 前端 `useChat` 与 UI 流协议现成，但压缩、工具进度、插话都要在它的接缝上凑，
  且绑定它的 UIMessage 结构；我们的对话 UI 要重度定制（画布联动、本轮消耗、结果卡片、澄清表单），
  省下的那层多半要拆掉重写。否决。
- **LangGraph JS 当库、不上 LangGraph Server。** 付了框架重量却拿不到 Server 层的追流与 `useStream`，
  自托管 Server 又硬要 Redis；checkpointer 引第二个 Postgres 驱动和一套不进现有迁移体系的表。否决。
- **DeepSeek Harness。** TypeScript、MIT、everything-is-a-plugin，但定位是本机编码代理（本地文件与
  shell 工具、Web UI 绑 `127.0.0.1`），2026-08 起 developer preview 且自述会有破坏性变更。否决。
- **自建最小循环。** 与采纳方案同样不动部署形态，但工具循环、provider 抽象、usage 归集与压缩挂点全要
  自己写自己养。否决。
- **pi 当库。** 采纳。

## Consequences

pi 是 0.x，四个月发了 45 个版本，跟版会痛：锁精确版本，升级单独走 PR。前端 SSE 线协议与 React 消息
状态机由我们拥有，没有社区现成实现可借。轮没有 durable execution：进程被强杀时当前轮的文字会丢，工具
任务本身在 `tasks` 表里不丢。`pi-ai` 把 Google、Anthropic、Bedrock 的 SDK 列为真实依赖，服务端安装
体积照吃。好处是 skills 走 Agent Skills 标准的 `SKILL.md` 目录，给分镜这类专业形态留了一条不写代码的路。
