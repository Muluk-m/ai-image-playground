# 技能走 Agent Skills 标准的 SKILL.md 目录，按创作类型分开、分三层渐进式加载

专业形态（分镜短片、电商主图、三视图设定图）需要一整套「先做什么、再做什么、什么时候该问」的流程
知识。这些知识写进系统提示词会把每一轮都撑大，写成工具又得为每个场景改一次代码。我们改用
[agentskills.io](https://agentskills.io) 的 `SKILL.md` 目录：`apps/bff/skills/<image|video|shared>/<skill-name>/SKILL.md`，
frontmatter 只有 `name` 与 `description`，正文是完整指引，同目录可以放 `references/*.md` 这类附属文件。
加载用 `@earendil-works/pi-agent-core` 自带的 `loadSkills`，读全文与读附属文件由我们自己的
`loadSkill` 工具做。这是 ADR 0003 结尾那句「skills 走 Agent Skills 标准的 `SKILL.md` 目录」的兑现。

**用框架的 loader，不用框架的 harness。** `loadSkills` / `formatSkillInvocation` 从包主入口导出，
不依赖 harness 层；`turn.ts` 直接 `new Agent(...)` 的接法不用动。实测 Bun 1.3 下 `NodeExecutionEnv`
（`node:fs` / `node:path`）与 `loadSkills` 正常工作，frontmatter 解析、ignore 文件、diagnostics
都拿得到，所以没有自己写 loader。但**模型没有任何文件系统读工具**，框架那套「把 `SKILL.md` 的绝对
路径写进系统提示词、让模型自己去读」在这里走不通，读文件这一步必须是我们自己的工具。

**三层渐进式加载。** 第一层是常驻上下文的 `<available_skills>` 清单，只有 `name` 与 `description`，
一条几十个 token；第二层是模型调 `loadSkill { name }` 把正文读进来；第三层是 `loadSkill { name, file }`
读该技能目录里的附属文件。代价是每次用技能多一次模型往返，换来的是技能数量可以长而每轮的固定
开销不长。`description` 因此是整套机制的承重墙：它写成「何时用 / 不处理什么」，决定模型会不会在对的
时候把正文读进来。

**位置写虚拟路径 `skill://<name>/SKILL.md`，不写磁盘路径。** 服务器绝对路径对模型没有任何用处，
写出去只会诱导它去猜一个它调不到的文件读工具，顺带把部署的目录结构告诉它。所以系统提示词里的
`<location>` 与 `formatSkillInvocation` 拿到的 `filePath` 都是虚拟路径，磁盘路径只留在服务端用来读
附属文件。附属文件的路径在 `readAgentSkillFile` 里挡死：规范化并解开软链之后仍必须在该技能自己的
目录里，绝对路径与 `..` 一律拒绝，另有大小上限。

**工具与技能都按创作类型（`AgentMode`）过滤。** 轮请求带可选 `mode`（`image` | `video`，缺席即
`image`，老客户端不知道有这回事）。图片轮的工具是 generateImage / editImage / readLibrary，视频轮在
此之上加 generateVideo——视频要先出首帧、改首帧，所以图片工具在视频轮里照样在场。`agentTools()` 与
`agentToolGuidance()` 用同一份过滤，保持「模型收到的清单」与「系统提示词里的指引」不各说各的。
`isAgentToolName` / `agentToolStart` / `agentToolEnd` **不**按 mode 过滤：历史里的生视频结果在图片轮
也要认得出来，否则那张卡就渲染不出来了。

**`mode` 不落库。** 它只影响这一轮装配给模型的东西：工具清单、技能清单、系统提示词那一句。重连与
重放读的是事件表，不重建工具；历史展示读的是消息表里的结果块，认不认得出工具名与 mode 无关；进程
被杀时这一轮本来就没了（ADR 0003）。下一轮的 mode 由客户端再发一次。所以没有加迁移。前端把选择记在
该会话的草稿里（IndexedDB），刷新后开关还在。

**显式调用 `/skill-name 其余文字`。** 服务端把该技能全文用 `formatSkillInvocation` 注入给模型，
**落库与回显的用户消息保持用户原文**——对话记录里不该突然多出一大段他没写过的指引。认不出的名字按
普通文字处理（用户本来就可能拿斜杠开头写正经话，`16/9` 这类也不该被吃掉）。注入同时进预扣估算，
两条路的输入形状仍然同源。

## Considered Options

- **把所有技能正文塞进系统提示词。** 零新增机制，但四条技能就已经是几千 token，而且每一轮都付；
  技能一多就会挤掉压缩阈值下真正的对话历史。否决。
- **把每个场景写死成一个工具**（`storyboardShort` / `productMainImage` …）。模型选得准，但加一个形态
  就要改一次代码、发一次版，运营写不了；而且工具清单本身是常驻上下文，并不比清单便宜。否决。
- **MCP prompts。** 协议现成、也有「列出再取用」的两段式，但要起一个 MCP server 或在进程内接一层
  client，而我们要的只是读几个 `.md`；pi 的 skills 路径已经在依赖里了。否决。
- **技能直接当文件给模型读**（照框架 `formatSkillsForSystemPrompt` 的原意）。要给模型一个通用的读文件
  工具，那等于在生图工作台里开一个文件系统入口，收益全无、风险全有。否决。
- **框架 loader + 自己的 `loadSkill` 工具。** 采纳。

## Consequences

技能目录是运行时读盘的，**不进模块图**，所以镜像必须显式带上它：`.dockerignore` 是 allowlist，加了
`!apps/bff/skills` 那一行；路径用 `import.meta.dir` 解析（镜像里 cwd 是 `/app`，靠不住）。漏掉任一条
都不会让构建或启动失败，只会让部署里一条技能都没有——所以 BFF 启动时打一条
`agent.skills_ready` 日志，那是唯一看得见的信号。

系统提示词变长了，预扣估算跟着变大一点（`agent-billing` 的两条上界因此放宽）。技能越多，这个常驻
成本越高，到某个数量就该改成「按 mode 再细分」或者先给模型一层目录。

`AgentToolName` 多了 `loadSkill`，前端第一次出现按工具名分支的地方：它渲染成一行轻量脚注，不出结果
卡、不占画布位、不扣生成积分。

种子技能（各 mode 两条）标注为草稿：内容来自 `docs/research/video-workflow-trace.md` 与
`docs/research/agent-native-video-mode.md` 的产品走查，没有经过真实用户与投放数据验证。
