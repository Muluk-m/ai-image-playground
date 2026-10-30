# Muvloom CLI 运行时与竞品安装研究

日期：2026-10-30

## 结论

Muvloom 不能把 npm / `npx` 作为唯一安装路径。用户机器没有 Node.js 的情况必须能完成首次使用。

推荐分发形态：

1. 原生、按平台构建的 `muvloom` CLI 二进制作为唯一首版交付物。
2. macOS / Linux shell installer；Windows PowerShell installer。
3. 后续按可行性增加 Homebrew 等包管理器和直接 release archive。
4. 首版不发布 npm 包，不依赖 Node.js、npm、Bun 或 Python。
5. Skill 的首次检测只执行 `muvloom auth status --json`；发现 CLI 缺失时，引用 `references/setup.md`，按机器平台选择原生安装，不要求先安装 Node。
…

## 竞品事实

| 产品 | 主运行时 / 安装方式 | 无 Node 是否可用 | Agent / Skill 相关能力 |
| --- | --- | --- | --- |
| Claude Code | 原生平台安装器、Homebrew、WinGet、apt/dnf/apk、桌面应用；npm 是替代路径 | 可以 | 首次浏览器登录；原生安装是官方推荐路径 |
| OpenAI Codex | Rust 原生二进制；shell / PowerShell installer、Homebrew、release archive；另有 npm 包 | 可以 | 首次 ChatGPT 登录或 API key 设置；官方提供 Skills 文档 |
| Vercel CLI | 官方安装文档主要是 pnpm / yarn / npm / bun | 未找到官方非 Node CLI 路径 | `vercel setup` 和 `vercel agent init` 提供 Agent 安装与项目指导 |
| Stripe CLI | Go 原生二进制；Homebrew、apt、yum/dnf、WinGet、Scoop、Docker、release archive；另有 npm 包 | 可以 | `stripe agent setup` 检测 Claude Code、Codex、Cursor 并安装相关内容；支持 JSON、`--yes` 等自动化选项 |
| Hugging Face `hf` | standalone installer、Homebrew、Python 包、`uvx` | 可以，不需要 Node | `hf skills add` 支持全局 / 项目安装；Agent 格式和 Device Flow 引导已纳入 CLI |
| ElevenLabs CLI | Rust 原生二进制；Homebrew、Scoop、shell / PowerShell installer；npm 是薄启动器 | 可以 | `generate-skills` 从 CLI 内置 API 定义离线生成匹配版本的 Skill |

## 关键观察

### npm / npx 不是无 Node 引导方案

Stripe 和 ElevenLabs 都提供 `npx`，但 `npx` 本身要求 Node.js/npm。它适合已有 Node 的一次性调用，不能解决“机器完全没有 Node”的首次安装。

### 成熟 CLI 通常把 npm 降为兼容渠道

Claude Code、Codex、Stripe、ElevenLabs 的共同模式是：npm 包仍存在，但原生安装器或平台包才是无 Node 用户的路径。Vercel 是样本中的例外，不应作为 Muvloom 的默认参考。

### Agent onboarding 正在成为 CLI 的一等能力

竞品已经把 Agent 安装、非交互登录、JSON 输出和版本匹配做成 CLI 能力：

- Stripe：`stripe agent setup`。
- Vercel：`vercel setup`、`vercel agent init`。
- Hugging Face：`hf skills add`，并支持 Agent 专用输出。
- ElevenLabs：`elevenlabs generate-skills`，不需要 API key，可离线生成。

这支持 Muvloom 保留 `muvloom skill install`，但它应是 CLI 的本地安装能力，不应把 Skill 变成第二套客户端实现。

## 主要来源

- Claude Code 安装与系统要求：<https://code.claude.com/docs/en/setup.md>
- Claude Code 快速开始：<https://code.claude.com/docs/en/quickstart.md>
- Claude Code npm 元数据：<https://registry.npmjs.org/@anthropic-ai/claude-code/latest>
- Codex README 与安装：<https://github.com/openai/codex/blob/main/README.md>
- Codex 安装文档：<https://github.com/openai/codex/blob/main/docs/install.md>
- Codex npm 元数据：<https://registry.npmjs.org/@openai/codex/latest>
- Vercel CLI：<https://vercel.com/docs/cli.md>
- Vercel Agent setup：<https://vercel.com/docs/cli/setup.md>
- Vercel Agent guidance：<https://vercel.com/docs/cli/agent.md>
- Stripe CLI：<https://docs.stripe.com/cli.md>
- Stripe Agent setup：<https://docs.stripe.com/cli/agent/setup.md>
- Stripe CLI repository：<https://github.com/stripe/stripe-cli#installation>
- Hugging Face CLI：<https://huggingface.co/docs/huggingface_hub/main/guides/cli.md>
- Hugging Face Agent CLI：<https://huggingface.co/docs/hub/agents-cli.md>
- Hugging Face package metadata：<https://pypi.org/pypi/huggingface_hub/json>
- ElevenLabs CLI：<https://elevenlabs.io/docs/eleven-agents/operate/cli.md>
- ElevenLabs CLI repository：<https://github.com/elevenlabs/cli>

## 对 Muvloom PRD 的影响

PRD 第 8、13 节目前把 npm 包作为发布主路径；本期裁决改为 Go-only 原生二进制。

- 首版只发布 Go 原生 CLI 二进制及薄安装入口；不发布 `@muvloom/cli`，不提供 `npx` 路径；
- `references/setup.md` 按 OS / architecture 给出原生安装路径，不要求 Node/npm；
- `auth status --json` 的 CLI 缺失状态必须能指导 Agent 选择原生安装路径；
- Skill 安装和 CLI 安装保持分离；两者都不能要求生成 API key；
- 原生 CLI 需要签名或至少 checksum 可验证、默认安装到用户可写目录，并提供非交互安装模式。

这些是基于官方资料归纳出的设计建议与本期裁决，不是竞品对成功率或安全性的保证。

