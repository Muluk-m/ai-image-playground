# CLI 默认文字输出，参数说明以 `--help` 为准

## 问题

CLI 0.1.x 的每条命令都只往 stdout 写一行 JSON 信封，`help` 也被当成 `USAGE` 错误：退出码 2，用法挤在 JSON 字符串里，`\n` 原样显示，参数没有说明。人在终端里几乎没法用。

Skill 把参数清单写死在自身文本里。Skill 和 CLI 分开安装、分开升级：WorkBuddy 的 Skill 停在旧版时，Agent 只能自己猜 `--format gif`、`--animate` 这类根本不存在的参数，因此做不出原生 GIF。

## 参照

Cloudflare 的 wrangler 与 `cloudflare/skills`（2026-11-08 查证 wrangler 4.105.0 及其文档）：

- 默认输出给人看的文字，错误带 `✘ [ERROR]` 前缀，退出码非 0。只有需要结构化结果的命令提供 `--json`。CI 用 `WRANGLER_OUTPUT_FILE_PATH` 另写一份 ND-JSON，不改动 stdout。
- `wrangler <命令> --help` 按分组列出参数，每个参数带说明、类型和默认值，退出码 0。
- 能识别 Claude Code、Codex 等 Agent，但识别结果只用于上报统计和 `--install-skills`，不改变输出格式。
- Skill 很薄，要求 Agent 不依赖记住的写法，参数用 `--help` 现查，配置字段查本地 schema。Skill 不与 CLI 版本绑定。

## 决定

CLI 0.2.0 起：

- **默认文字输出**。结果写 stdout，格式为 `key: value` 行，字段名与 JSON 一致，嵌套缩进。这样按 JSON 字段写的旧 Skill（`state: ready`、`wait_timed_out`、`should_prompt`）读文字结果仍对得上。`capabilities`、`jobs list`、`media list`、`version` 另有紧凑排版。毫秒时间戳显示为本地时间，`bytes` 显示带单位的大小。
- **失败写 stderr**：先是 `Error: <message> (<CODE>)`，再跟 details 和一句下一步建议。退出码与 0.1.x 完全相同。
- **全局 `--json`**：可以放在 `--` 之前的任意位置，输出原有的 `schema_version` / `ok` / `data` / `error` 信封，结构不变。
- **帮助是文字，退出码 0**：`muvloom`、`muvloom --help`、`muvloom help <命令>`、`muvloom <组> --help`、`muvloom <命令> --help`。命令帮助列出 FlagSet 里的每个参数，附说明、占位符、默认值、补充说明和示例。帮助在读取凭据存储和访问网络之前就返回。缺少子命令、未知命令或未知参数仍是 `USAGE`（退出码 2），并提示该看哪一页帮助。
- **Skill 瘦身**：删掉写死的参数清单，改为先跑 `muvloom <命令> --help`。`references/cli.md` 只写输出方式、各命令该读哪些字段、ID 和退出码。
- **提示旧 Skill**：`auth status` 发现已安装的 Skill 版本不是当前内置版本时，在 stderr 提示对应的 `skill install` 命令。两种输出模式下都会提示。

## 取舍

- **不按终端或调用方自动切换格式**：有的 Agent 宿主在伪终端里执行命令，切换会让同一条命令的输出变得不可预期。Cloudflare 也没有这样做。
- **不加 ND-JSON 输出文件**：没有 CI 消费者，需要时再加。
- **文字格式不是契约**：脚本和需要全部字段的 Agent 用 `--json`。文字只保证字段名可读，排版可以调整。

## 兼容与发布

- 旧 Skill 配新 CLI：拿到的是文字，字段名不变，大多数步骤照常。旧 Skill 里"读 `data.x`""看 `ok`"一类说明会失效，`auth status` 的旧 Skill 提示可以补上这一点。
- 按 [CLI 发布流程](../agents/cli-release.md)，同一个 PR 分两个提交：第一个提交升版本号，CI 通过后打 `cli-v0.2.0` 标签并发布；第二个提交把接入指南（`setup.md`、两份 WorkBuddy 指南）和 `connectAgents.ts` 钉到已发布的 0.2.0，之后才合并。所以网站上线时，指南里的文字输出描述和安装的版本是一致的。WorkBuddy 技能包随网站部署重新生成。
- 安装脚本打印的版本行会变成 `muvloom 0.2.0 (os/arch)`。安装冒烟改用 `--json` 解析，并新增文字与帮助的检查。
