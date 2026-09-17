# apps/bff

BFF 内部约定。仓库级约定见根 `CLAUDE.md`。

## BFF 定位

BFF 的公开核心只做四件事：

1. **任务队列代理** — 绕浏览器 / Edge / CF Pages 这类平台的 100s idle timeout（Gemini 3 Pro Image 单张能跑 30-300s）。前端发 `submit / status / fetch` 三段 < 1s 快请求，BFF 内部跑长 fetch 调上游。
2. **Secret 守门人** — 上游 API key 只在 BFF 进程 env 里，浏览器永远拿不到；这是「内置 channel」能让没 key 的用户也能用的前提。
3. **持久化 + 幂等** — PostgreSQL 存 task，浏览器刷新 / 关 tab 后用 `client_request_id` 幂等恢复，不重复扣额度。
4. **托管前端静态产物** — `apps/web/dist` 由 BFF serve（`STATIC_DIR` env），跟 BFF 同源省 CORS preflight。

私有 BFF overlay 可以在这些接缝上增加计费等部署专属能力；它仍必须遵守 BFF
是唯一写入者、提交与预扣同事务、worker 结算或退回的纪律。

**BFF 不做**：通用协议翻译。`upstream.ts` 只允许已验证的 channel 兼容性适配（端点 / body 形状选择，以及上游不支持多图数量时的 `n` fan-out + 结果合并）；不要把它扩成任意 OpenAI / Gemini 字段转换代理。普通部署的 BYOK profile 完全绕过 BFF（前端直接 fetch 用户填的 baseUrl，BFF 看不到也存不了 BYOK 的 key）；开启 `billing:credits` 的经营部署禁用 BYOK，只允许内置 channel。

## 内置 channel 机制

代码：[`channels.json`](./channels.json) + [`src/lib/channels.ts`](./src/lib/channels.ts) + [`src/routes/channels.ts`](./src/routes/channels.ts)。

- channel id 强制 kebab-case，`auth.secretRef` 指向环境变量名（**UPPER_SNAKE_CASE，不是真值** — 校验器会拒绝长得像 `sk-...` / `AIza...` 的字符串）
- `baseUrlRef` 与 `baseUrl` 二选一，同样指向环境变量名（如 `GROK_BASE_URL`），用于上游地址本身不能进公开仓库的 channel。值必须是**能解析出主机名的 https URL**（channel key 随请求发出，明文 http 会泄露它；只有 `localhost` / `127.0.0.1` / `::1` 允许 http，给本机 dev 反代留口）；env 缺失或不合法时该 channel 整条丢弃并 warn，不回落任何字面地址
- 真实 API key 只在 BFF 进程的 env 里；客户端永远不带 `Authorization`
- BFF 启动时 `initChannels()` 解析 channels.json + 解析 `process.env[secretRef]`；缺 secret 只 warn 不 fatal。
  声明了 `requiresSecret: true` 的 channel 例外：缺 key 时整条丢弃、不进发现清单（直连上游没 key
  就只是个必然失败的模型，如 `veo-video`）
- `GET /api/channels` 暴露 sanitized channel 列表（不含 `baseUrl` / `auth` / `allowedPaths`）给前端 boot 时拉
- UI 必须保持完全隐藏 baseUrl / apiKey；模型可下拉切换
- **channels.json 数组顺序是产品契约**：`channels[0]` 是新访客的默认模型（前端按序注入 profile 并兜底选第一个）。新增 channel 往后排
- worker 调上游默认走 `UPSTREAM_BASE_URL` 通用网关（env 约定 baseUrl **不含**版本段）；独立直连上游的 channel 要加进 `upstream.ts` 的 `DIRECT_CHANNEL_IDS`，baseUrl/key 单源 channels.json（约定 baseUrl **含**版本段，如 `.../v1`）
- **上游能力声明跟着它描述的那个 baseUrl 走**，这是异步图片任务开关落两处的原因：
  - 直连 channel → `channels.json` 的 `defaults.asyncTasks`（与 baseUrl 同处，如 `grok-images`）
  - 通用网关 → env `UPSTREAM_ASYNC_IMAGE_TASKS`（与 `UPSTREAM_BASE_URL` 同处，覆盖 `gpt-image-2` 这类未命中 `CHANNEL_ROUTE_STYLES` 的 channel）

  网关部署里 `openai-images` 那条 channel 的 `baseUrl: https://api.openai.com/v1` 只是名义地址，`resolveUpstream` 压根不读它；在那儿写 `asyncTasks: true` 字面含义是「api.openai.com 有 /async 端点」，是假的。网关是不是 sub2api 只有 env 知道。
- 打开异步后 worker 提交拿 `imgtask_…` 落库再轮询，重启按 id 接着轮，不重提交、不重计费。**上游没有幂等键**：已落库的 id 一律只轮不重提，重试只补提交缺口。要关上游的异步开关，先关我们这边的声明位——否则提交一律 404（日志 event `upstream.async_disabled`），没有静默回落同步。
- 网关的 Images 桥接主模型不可用时，可设 `UPSTREAM_IMAGE_RESPONSES_MODEL=gpt-6-astra`：仅通用网关的 `gpt-image-*` 新任务改走 `/v1/responses`，图片工具模型保持被选中的那个；该声明优先于异步图片开关，留空保留原协议。已落库的 `imgtask_…` 仍按原协议恢复。新 Responses 请求不产生可恢复任务 id，断流/超时按结果未知处理，不自动重提；图片片段只有收到成功完成事件后才能交付。

## Queue 模式协议（apps/web ↔ apps/bff）

- 前端按 fal.ai-style 协议跟 BFF 交互：`submit → polling → fetch result`，三个端点都是 < 1s 快请求
- channel kind 在前端层叫 `openai-queue` / `gemini-queue`；到 BFF URL 段 `/v1/queue/{provider}/{model}/submit` 时映射为 `openai-compat` / `gemini`（参见 `queueClient.ts` 的 `toQueueProvider`）
- 协议 types 在 [`packages/shared/src/queue-protocol.ts`](../../packages/shared/src/queue-protocol.ts)
- BFF channel 发现协议 types 在 [`packages/shared/src/channel-discovery.ts`](../../packages/shared/src/channel-discovery.ts)

## 智能体技能（Agent Skills）

代码：[`src/lib/agent/skills.ts`](./src/lib/agent/skills.ts) + [`src/lib/agent/tools/loadSkill.ts`](./src/lib/agent/tools/loadSkill.ts)。
设计与否决方案见 [ADR 0007](../../docs/adr/0007-agent-skills-progressive-loading.md)。

- 目录约定 `skills/<image|video|shared>/<skill-name>/SKILL.md`，按
  [agentskills.io](https://agentskills.io) 标准。`shared/` 下的两个 mode 都看得见；同名时
  mode 专属的那份胜出。同目录可放 `references/*.md` 这类附属文件。
- frontmatter 只认 `name` 与 `description`。**`name` 必须与父目录同名且是 kebab-case**（框架
  loader 会校验，不符只记 diagnostic 不丢弃）；**`description` 缺席那条技能直接被丢掉**。
- **正文第一行写一个中文一级标题**（`# 分镜短片`），它就是界面上那个名字（`title`）：标准把
  `name` 钉死成 kebab-case，直接显示就是一串英文。没有一级标题时回退到 `name`。标题只进
  `/` 菜单与面板上「读取技能：…」那一行，**不进系统提示词的 `<available_skills>`**——那里只有
  name / description / location。
- **`description` 写成「何时用 / 不处理什么」**，这是 Agent Skills 的惯例，也是常驻上下文里
  唯一进模型眼睛的东西——它决定模型会不会在对的时候调 `loadSkill` 把正文读进来。写成一句功能
  介绍等于关掉这条技能。
- **正文只能引用该 mode 下真实存在的工具名与参数**。图片轮是 generateImage / editImage /
  readLibrary，视频轮多一个 generateVideo。写了不存在的工具，模型会照着编。
- 启动时加载一次并缓存（`ensureAgentSkills()`），diagnostics 打 warn 不 fatal。测试用
  `setAgentSkillsRootForTesting(dir)` 换根目录并丢缓存。
- **加目录记得同时看 `.dockerignore`**：那是 allowlist，`!apps/bff/skills` 那一行不在就打不进镜像，
  而且构建与启动都不会报错，只会一条技能都没有。路径一律 `import.meta.dir` 解析，镜像里 cwd 是
  `/app`，靠不住。
- 怎么测：加载与 diagnostics 用临时目录（`src/__tests__/lib/agent/skills.test.ts`），
  按 mode 过滤工具与系统提示词（`src/__tests__/lib/agent/tools/modes.test.ts`），
  端点与 `/skill-name` 显式调用（`src/__tests__/routes/agent-skills.test.ts`）。
  **改 `skills/` 下随仓库发的那几条技能会动到路由测试里的工具清单断言**——`loadSkill` 只在
  该 mode 有技能时才进清单。
- **随仓库发的技能有一份体检**（`src/__tests__/lib/agent/shipped-skills.test.ts`）：它加载真实的
  `apps/bff/skills`，断言零 diagnostic、每条有中文一级标题、`description` 含「何时用 / 不处理」
  且不超过 120 字、`name` 与目录同名、同一 mode 内不重名、正文里反引号包着的工具名都属于该 mode
  的工具集合（图片技能正文里不许出现 `generateVideo`）。加技能先看它。
- **技能条数会推高每轮的预扣**：`description` 进每一轮的系统提示词，条数一多
  `agent-billing.test.ts` 里那两条 `unitMultiplier` 区间就会被顶穿。那不是 bug，如实调区间并在
  注释里写清这次为什么上移。
