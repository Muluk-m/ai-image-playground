# 在 Claude Code 与 Codex 中使用幕芽（Skill + CLI）

这篇是给人读的集成文档，依据仓库 `cli-go/`（Go 二进制 `muvloom`，模块名 `github.com/Muluk-m/ai-image-playground/cli-go`）、随二进制打包的 Skill（`cli-go/internal/skill/assets/`）、网站接入页（`apps/web/src/features/cli/`）以及 BFF 路由（`apps/bff/src/routes/cli.ts`）写成。当前网站接入页写明的发布版本是 **CLI 0.2.4**，安装脚本钉在提交 `940f1faf1f4147d4b0add11efa5d3684aef0439c`。

结论先说：这不是 npm 包。仓库里没有 `@muvloom/cli`，`npm` 上也没有以此为名的官方包。正式分发是单文件原生二进制 `muvloom`（macOS arm64/x64、Linux x64/arm64、Windows x64），不需要 Node.js、npm 或 Python。Skill 通过 `muvloom skill install --host claude-code|codex` 安装；Claude Code 里用 `/muvloom …` 调用，Codex 里用 `/` 选中 Skill 或 `$muvloom …`。

给智能体自动安装用的原文在：

- https://muvloom.online/cli/setup.md
- https://muvloom.online/cli/workbuddy.md

人看的接入页在 https://muvloom.online/connect （测试环境对应 `https://test.muvloom.online/connect`）。设备码批准页在 `/device`。

---

## 1. 已经做了什么，什么还没做

已经做了：

- CLI 命令：`auth login|status|logout`，`capabilities`，`images create|validate`，`jobs list|get|wait|cancel`，`artifacts get|download`，`media upload|list|get|download`，`skill install|status`，`update check`，`version`。
- RFC 8628 设备码登录。CLI 打开浏览器（或打印链接），用户在网站登录并批准；CLI 轮询换取令牌。授权码有效期在 `setup.md` 里写的是 20 分钟。
- 原生 GIF / SVG：在模型的 `output_formats` 含 `gif` 或 `svg` 时，用 `--output-format gif|svg` 一次出片。
- 4K 会员闸：服务端返回 `PLAN_REQUIRED`（HTTP 403），CLI 退出码 4。
- Skill 宿主：`--host` **只接受** `claude-code` 与 `codex`。`--scope` 为 `user`（默认，所有项目）或 `project`（当前目录）。

没有做、不要 invent：

- 没有 npm 包 `@muvloom/cli`，没有 `npx @muvloom/cli`。
- `muvloom skill install --host` **不接受** `workbuddy`、`doubao` 或其他值（传入会 `USAGE`）。WorkBuddy 走 `/cli/workbuddy.md` 与 `/cli/muvloom-workbuddy.zip`；豆包工作要在其客户端「插件·技能·伙伴」里上传技能，没有对应的 `--host`。
- CLI **没有** `--n` / 张数参数。BFF 把每次 CLI 出图记成 `count: 1`。一次请求出一张；套图由 Skill 按 `image-sets.md` 拆成多次请求。
- CLI **没有**视频生成命令。`capabilities` / `images *` 走的是 `/v1/capabilities` 与 `/v1/image-jobs`。
- 用户不应手拼 HTTP。下面列出的 `/v1/…` 路由是 CLI 实际调用的服务端接口，只作对照，不是公开给人手写 curl 的教程。

---

## 2. 安装 CLI 0.2.4

接入页给出的命令（`connectAgents.ts`）会校验下载文件的 SHA-256，并把脚本钉在已发布提交上，而不是可移动的 `main`。

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/Muluk-m/ai-image-playground/940f1faf1f4147d4b0add11efa5d3684aef0439c/cli-go/install/install.sh | MUVLOOM_VERSION=0.2.4 sh
export PATH="${MUVLOOM_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
```

Windows（PowerShell）：

```powershell
$env:MUVLOOM_VERSION = "0.2.4"; irm https://raw.githubusercontent.com/Muluk-m/ai-image-playground/940f1faf1f4147d4b0add11efa5d3684aef0439c/cli-go/install/install.ps1 | iex
$env:Path = [Environment]::GetEnvironmentVariable("Path","User") + ";" + [Environment]::GetEnvironmentVariable("Path","Machine")
```

装好后先跑 `muvloom version`。版本低于 0.2.4 应重装：安装器就地替换二进制并保留已有登录。默认安装位置（可用 `MUVLOOM_INSTALL_DIR` 覆盖）：已安装副本所在目录，否则在 PATH 上可写的 `/usr/local/bin`，否则 `~/.local/bin`（Unix）或 `%LOCALAPPDATA%\Programs\muvloom`（Windows）。

Skill 自带的 `install.md` 还提供不钉版本、跟踪 `main` 的短命令。**给用户复制时以接入页钉死的 0.2.4 为准**，避免脚本与二进制版本漂移。

查找已安装副本（agent 环境经常没有 PATH）：`~/.local/bin/muvloom`、`/usr/local/bin/muvloom`、`/opt/homebrew/bin/muvloom`；Windows 为 `%LOCALAPPDATA%\Programs\muvloom\muvloom.exe`。

---

## 3. 选择服务（生产 / 测试）

CLI 默认 API 是 `https://api.muvloom.online`（`DefaultAPIURL`）。第一次登录用环境变量 `MUVLOOM_API_URL` 选服务；登录成功后连接会记住对应服务，以后不必再设。

`setup.md` 里的对照表：

| 你打开的页面来源 | 应设置的 `MUVLOOM_API_URL` |
| --- | --- |
| https://muvloom.online | https://api.muvloom.online |
| https://image.nainma.online | https://api.muvloom.online |
| https://image-playground.qiliangjia.one | https://image-api.qiliangjia.one |
| https://test.muvloom.online | https://test-api.muvloom.online |

连测试环境：

```sh
export MUVLOOM_API_URL="https://test-api.muvloom.online"
muvloom auth login
```

如果变量指向的服务和本机已登录的服务不同，`auth status` 会报 `state: service_mismatch`。不要擅自再登一次：清掉变量以沿用现有连接，或在用户明确要换服务时执行 `muvloom auth login --switch-service`。

其他环境变量：

| 变量 | 作用 |
| --- | --- |
| `MUVLOOM_NO_BROWSER=1` | 不打开浏览器，只打印批准链接（SSH、容器） |
| `MUVLOOM_CONFIG_DIR` | 连接信息存放目录；设了它就只用该目录里的文件登录，不碰钥匙串 |
| `MUVLOOM_CREDENTIALS_STORE=file` | 凭据写入配置目录，而不是系统钥匙串 |

不要向用户索要密码、Cookie 或令牌，也不要打印已存储的凭据。

---

## 4. 安装 Skill（Claude Code / Codex）

```sh
muvloom skill install --host claude-code
muvloom skill install --host codex
muvloom skill install --host codex --scope project   # 仅当前项目目录
muvloom skill status
```

`--host` 只能是 `claude-code` 或 `codex`。`--scope` 默认 `user`，也可为 `project`。`skill status` 会报告安装位置和版本。自 CLI 0.2.2 起，`auth status` 还会把该 CLI 安装过、且未被用户改过的旧 Skill 副本更新到随包版本；改过的、残缺的或更新的副本不动。宿主要到下一轮会话才加载新 Skill。

调用方式（`getting-started.md`）：

| 宿主 | 怎么唤起 | 例子 |
| --- | --- | --- |
| Claude Code | `/muvloom` | `/muvloom 生成一张小猫表情包` |
| Codex 桌面 | `/` 选中 Muvloom Skill，或 `$muvloom` | `$muvloom 用这张商品照片制作一套电商图` |
| Codex CLI / IDE | `/skills` 选 Muvloom，或 `$muvloom` | `$muvloom 用指定的可用模型生成一张小猫表情包` |
| 未装 Skill 的宿主 | 自然语言提到幕芽 / muya / muvloom | `用幕芽生成一张小猫表情包` |

这些是聊天里的唤起，不是终端命令。终端里可执行文件名始终是 `muvloom`。

WorkBuddy：按 https://muvloom.online/cli/workbuddy.md 在对话里安装官方技能（zip：`/cli/muvloom-workbuddy.zip`），确认技能出现在 WorkBuddy 后再声明完成。豆包工作：跳过 `skill install`，不要编造 `--host doubao`。

---

## 5. 登录（设备码流程）

这是 RFC 8628 设备授权。CLI 向 `POST /v1/oauth/device_authorization` 申请设备码，打开（或打印）带 `user_code` 的批准页 `/device`，再轮询 `POST /v1/oauth/token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`）。退出时走 `POST /v1/oauth/revoke`。

```sh
muvloom auth status          # 先看现在的状态
muvloom auth login           # 打开批准页并等待
muvloom auth login --no-wait # 只打印链接，不等待
muvloom auth login --timeout 15
muvloom auth login --switch-service
muvloom auth logout          # 吊销并忘记本机连接
```

`auth login` 的行为：

- 默认自己打开浏览器并等待，直到用户批准或设备码过期。超时后再次执行**同一条** `auth login` 会恢复同一次登录，不会另开一页。
- `--no-wait` 打印 `verification_uri_complete` 后立刻返回。远程环境应设 `MUVLOOM_NO_BROWSER=1`，在用户自己的浏览器打开该链接，再跑一次 `muvloom auth login` 等待。
- `--timeout SECONDS` 限制等待秒数；省略则等到设备码失效为止。代码把超时夹在 0–3600 秒。
- 不要在等待过程中反复提醒用户。用户拒绝是 `AUTH_DENIED`，应停止；只有 `AUTH_EXPIRED` 才重新开始一轮登录。

`auth status` 的 `state`：

| state | 含义 |
| --- | --- |
| `ready` | 已连接，可以生成 |
| `unauthenticated` | 尚未登录 |
| `outdated` | CLI 太旧，需要重装 |
| `unreachable` | 暂时连不上服务 |
| `service_mismatch` | `MUVLOOM_API_URL` 与已存连接不一致 |

就绪后的 `auth status` 还会带上 API 地址及来源、凭据存储、账户、积分、会员状态、已安装 Skill 等信息。登录本身不消耗积分。

网站侧：登录用户可在 `/connect` 看到并撤销「插件集成」连接（`GET /api/me/cli-connections`，`DELETE /api/me/cli-connections/:id`）。批准页是 `/device`（`GET/POST /api/cli/device`）。

---

## 6. 第一次运行

完整顺序（与 `setup.md` 一致）：

1. `muvloom version`（需要 ≥ 0.2.4）。
2. 如需非默认服务，设置 `MUVLOOM_API_URL`。
3. 按宿主安装 Skill（Claude Code / Codex）。
4. `muvloom auth status`；不是 `ready` 就 `muvloom auth login`。
5. `muvloom capabilities` 必须成功，才能宣布「可以生成」。用这次返回的模型列表说话：展示 `label`，标出 `default_model`，并根据每个模型的 `output_formats` 说明它能否直接出 GIF / SVG。不要写死一份模型目录，也不要在用户没问时报价格。

`capabilities` 对应当前账户可见的模型、比例、尺寸、质量、参考图上限、基础单价，以及该模型的 `gif` / `svg` 限制。价格是倍率 1 时的基础积分；具体一单的报价用 `images validate`，不要拿基础单价当最终报价。

用户的生成请求本身即授权生成：不要先报价再二次确认。只有用户主动问价格时才报价；只有用户明确给出积分上限时才加 `--max-credits`。

---

## 7. 命令与参数

通用：`muvloom --help` 列出全部命令；`muvloom <command> --help` 列出该命令的旗标、默认值、限制和例子。任意命令可加 `--json`（写在 `--` 之前任意位置），成功时 stdout 只有一行 `{"schema_version":1,"ok":true,"data":…}`，失败为 `{"schema_version":1,"ok":false,"error":{"code","message","details"}}`。默认文本模式是 `key: value`；失败在 stderr 打印 `Error: message (CODE)`。

### 7.1 生成

```sh
muvloom images validate --prompt "a poster" --image-size 4K
muvloom images create --prompt "a cat sticker, white background" --wait 300 --download ./out
muvloom images create --prompt "the same bottle on a beach" --ref ./bottle.png --aspect-ratio 1:1 --wait 300 --download ./out
muvloom images create --model gpt-image-2.6-flare --output-format gif --frames 8 --prompt "a cat waving, looping" --wait 300 --download ./out
```

`images create` 与 `images validate` 共用这些旗标（`cli-go/internal/cli/images.go`）：

| 旗标 | 含义 |
| --- | --- |
| `--prompt TEXT` | 要生成的内容。与 `--prompt-file` 至少提供一个 |
| `--prompt-file FILE` | 从 UTF-8 文件读取提示词（长文本或多行） |
| `--model ID` | `capabilities` 里的模型 id；省略则用默认模型 |
| `--aspect-ratio RATIO` | 模型列出的比例，例如 `1:1`、`16:9`、`auto` |
| `--image-size SIZE` | 模型列出的尺寸，例如 `1K`、`2K`、`4K` |
| `--quality LEVEL` | 模型列出的质量，例如 `low`、`medium`、`high` |
| `--ref FILE\|MEDIA_ID` | 参考图：本地 `.png/.jpg/.webp`（自动上传）或已有 `media_id`；可重复 |
| `--max-credits N` | 报价超过 N 积分则拒绝创建 |
| `--output-format gif\|svg` | 仅当模型的 `output_formats` 包含该项；省略则出普通图 |
| `--frames N` | GIF 帧数，上下限见 `capabilities` 的 `gif` |
| `--frame-duration-ms MS` | GIF 每帧毫秒 |
| `--frame-size WxH` | GIF 帧尺寸，例如 `512x512` 或 `768x768` |

仅 `images create` 额外有：

| 旗标 | 含义 |
| --- | --- |
| `--idempotency-key KEY` | 8–64 位，字符集 `A-Za-z0-9_.:-`；省略则自动生成 `cli-` + hex |
| `--wait SECONDS` | 提交后最多等这么久（上限 3600）；`0` 表示提交完就返回 |
| `--download DIR` | `--wait` 成功结束后把结果存进该目录 |

`images validate` 使用同一套生成旗标，**不创建任务、不扣积分**，只校验并报价。

帮助页写明：GIF 或 SVG **不要**带 `--ref`、`--aspect-ratio`、`--image-size` 或 `--quality`。服务器会在扣积分前用 `INVALID_REQUEST` 拒绝非法组合。产品侧 GIF 合法帧尺寸是 `512x512` 与 `768x768`，帧数整数范围 2–16（界面常用档 4 / 6 / 9 / 12 / 16），每帧时长 20–2000ms 且为 10 的倍数。GIF / SVG 都是每请求一张。

参考图走 `media upload`：本地文件先上传得到 `media_id`，再写入 `reference_media_ids`。单张上限与网站一致，文档与界面均写单张不超过 50MB。

### 7.2 任务、产物与参考图

```sh
muvloom jobs list [--limit N] [--cursor JOB_ID] [--idempotency-key KEY]
muvloom jobs get JOB_ID
muvloom jobs wait JOB_ID [--timeout SECONDS]
muvloom jobs cancel JOB_ID
muvloom artifacts get ARTIFACT_ID
muvloom artifacts download ARTIFACT_ID [--output PATH]
muvloom media upload FILE
muvloom media list [--limit N] [--cursor MEDIA_ID]
muvloom media get MEDIA_ID
muvloom media download MEDIA_ID [--output PATH]
```

三种 ID 不可混用：`job_id` 是任务，`artifact_id` 是生成结果，`media_id` 是上传的参考图。

---

## 8. 等待、恢复与取消

任务状态：`queued` → `running` → `persisting`（结果已写入、正在收尾）→ `succeeded`，或 `failed` / `canceled`。`terminal: true` 表示不会再变。

`jobs wait` 按服务端节奏轮询，直到结束或超时。超时**不是失败**：返回里带 `wait_timed_out: true`，任务仍在跑。应继续 `jobs wait` 同一 `job_id`，除非用户要求后台提交。不要因为等待超时就再 `images create` 一单。

任务一旦被服务端接受，即使后来等待或下载失败，错误详情里仍会带 `job_id` 与 `idempotency_key`。用同一 `--idempotency-key` 和相同参数再跑 `images create`，会回到原任务而不会再扣一次积分。已用相同字节保存过的文件会报 `already_present: true`，不会覆盖；目标路径已有不同内容则是 `FILE_EXISTS`，应换 `--download` 目录，**不要删用户文件**。

提交响应丢失时：`muvloom jobs list --idempotency-key KEY` 找回任务，再 `wait` 或下载产物。

取消：仅在用户明确要求时执行 `muvloom jobs cancel JOB_ID`。排队中或运行中的任务会停止并退回积分。已经进入 `persisting` 的任务不能取消，错误码 `JOB_NOT_CANCELLABLE`（图片已经生成、正在保存）。结束为 `failed` 或 `canceled` 的 `jobs wait` 退出码为 4（`JOB_FAILED` / `JOB_CANCELED`）。

成功任务列出 `artifacts`；用 `artifacts download` 逐个保存。下载链接是短时的，每次现取；下载失败不影响任务本身，不要为了修下载再生成一次。完成后的 `actual_credits` 是实际扣除的积分；失败和取消会自动退回。

---

## 9. 积分与会员（含 4K 门闩）

- 具体一单的积分用 `images validate` 查询，不要把 `capabilities` 里的基础单价当成最终报价（尺寸、质量会乘倍率）。
- `--max-credits N` 只在用户明确给出上限时使用。超出会返回 `MAX_CREDITS_EXCEEDED`（退出码 5），详情带 `required`。
- 余额不足：`INSUFFICIENT_CREDITS`（退出码 5），详情带 `required` 与 `available`。不要重试。
- 当日额度用尽：`QUOTA_EXCEEDED`（退出码 5），详情带 `reset_at`。不要重试，也不要改走别的通道。
- **4K 需要有效会员**。对 `gpt-image-2.6-flare` 传入 `3840x2160` 这类 4K 尺寸时，网站侧 `preparedComposerNeedsMembership` 为 true；CLI 会收到 `PLAN_REQUIRED`（退出码 4）。处理方式：改用更小的 `--image-size`（1K 或 2K），或告知用户需要会员。不要改模型来绕开用户点名的 4K。
- GPT Image 2.6 静态图积分（来自 `packages/shared/src/gpt-image-26.ts`，Flare 与 Sunburst 同价）：1K 低/中/高为 190 / 330 / 400；2K 与 4K 低/中/高为 380 / 670 / 810。编辑（带参考图）在同档生成价上按 390/330 取整到 10，并每多一张参考图加 60。GIF：≤6 帧 370，7–9 帧 550，10–16 帧 980。SVG：610。这些是产品积分，不是成本。
- Skill 指示：用户没问就不要报价格。

---

## 10. 退出码与错误码

退出码（`help.go` / Skill `cli.md`）：

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 未预期的内部错误 |
| 2 | 命令或请求不合法 |
| 3 | 未登录，或登录待批准 / 被拒 / 过期 |
| 4 | 被拒绝（会员、找不到、冲突、模型不可用、文件已存在、服务不一致、凭据无法写入），或等待的任务失败/被取消 |
| 5 | 积分不足、超过 `--max-credits`，或当日额度用尽 |
| 6 | 临时错误（网络、限流、服务忙），可用同一幂等键重试 |
| 7 | CLI 太旧 |

错误码（stderr 的 `(CODE)` 或 `--json` 的 `error.code`）：

| 码 | 含义 | 该做什么 |
| --- | --- | --- |
| `AUTH_REQUIRED`, `UNAUTHENTICATED` | 没有有效连接，或登录码无效/已用 | 看 `auth status`，按需走登录 |
| `SERVICE_MISMATCH` | `MUVLOOM_API_URL` 与已存连接不一致 | 不要新开登录；清变量或 `--switch-service` |
| `AUTH_EXPIRED` | 登录码过期 | 重新开始登录 |
| `AUTH_PENDING` | 用户尚未在浏览器批准 | 继续 `auth login`，不要另开一页 |
| `AUTH_DENIED` | 用户拒绝 | 停止，除非用户要求再试 |
| `CREDENTIAL_STORE_UNWRITABLE` | 无法写入凭据（配置目录或钥匙串） | 让配置目录可写，或设 `MUVLOOM_CONFIG_DIR` 后再 `auth login` |
| `PLAN_REQUIRED` | 该请求需要会员（例如 4K） | 换小尺寸，或告知需要会员 |
| `INSUFFICIENT_CREDITS` | 积分不够 | 告知用户，不要重试 |
| `QUOTA_EXCEEDED` | 当日额度用尽，`reset_at` 为重置时间 | 告知用户，不要重试 |
| `MAX_CREDITS_EXCEEDED` | 超过 `--max-credits` | 报告并停，保留该上限 |
| `IDEMPOTENCY_CONFLICT` | 同一密钥搭配了不同参数 | 换新密钥 |
| `INVALID_REQUEST` | 提示词、模型、比例、尺寸、质量或参考图不合法 | 按 `message` / `details.available` 修改 |
| `MODEL_UNAVAILABLE` | 模型暂时关闭 | 刷新 `capabilities`；用户点名的模型不可用时不要擅自换 |
| `NOT_FOUND` | ID 不存在或不属于此账号 | 核对 ID |
| `JOB_FAILED` | 等待的任务没有出图 | 对已结束且原因为 `rate_limited` / `upstream_timeout` / `interrupted` 的，可换新幂等键重试一次；其他失败只报告。不要重提未结束或已取消的任务 |
| `JOB_CANCELED` | 任务被取消 | 报告 |
| `JOB_NOT_CANCELLABLE` | 当前状态不能取消（通常是 `persisting`） | 告知用户图片已在保存 |
| `FILE_EXISTS` | 下载目标已有不同内容 | 换 `--output` / `--download`，不要删用户文件 |
| `RATE_LIMITED`, `NETWORK_ERROR`, `TEMPORARILY_UNAVAILABLE`, `INTERNAL_ERROR` | 临时故障 | 稍后再试同一操作；创建用同一幂等键 |
| `CAPABILITY_UNAVAILABLE` | 此服务器未开启 CLI | 报告 |
| `UNSUPPORTED_VERSION`, `UPGRADE_REQUIRED` | CLI 太旧 | 按第 2 节重装 |
| `USAGE` | 命令行用法错误 | 看该命令的 `--help` |

---

## 11. 服务端路由对照（CLI 实际调用，不是手写 API 教程）

来自 `apps/bff/src/routes/cli.ts`：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/oauth/device_authorization` | 申请设备码 |
| POST | `/v1/oauth/token` | 用设备码换令牌 |
| POST | `/v1/oauth/revoke` | 吊销 |
| GET | `/v1/me` | 当前 CLI 身份 |
| GET | `/v1/capabilities` | 模型与限制 |
| POST | `/v1/image-jobs/validate` | 校验并报价 |
| POST | `/v1/image-jobs` | 创建出图任务 |
| GET | `/v1/jobs` | 任务列表 |
| GET | `/v1/jobs/:id` | 单个任务 |
| POST | `/v1/jobs/:id/cancel` | 取消 |
| POST | `/v1/media` 与 `/v1/media/:id/complete` | 上传参考图 |
| GET | `/v1/media`、`/v1/media/:id`、`/v1/media/:id/download` | 查询/下载参考图 |
| GET | `/v1/artifacts/:id`、`/v1/artifacts/:id/download` | 查询/下载产物 |
| GET/POST | `/api/cli/device` | 网站批准页 |
| GET | `/api/me/cli-connections` | 已连接的 CLI |
| DELETE | `/api/me/cli-connections/:id` | 撤销一条连接 |

这一组使用 Bearer 边界，和网站自己的 `/v1/queue` 协议分开。

---

## 12. 常见问题

**Q：用 npm 怎么装？**  
A：不能。没有官方 `@muvloom/cli`。用上面的 `install.sh` / `install.ps1`。

**Q：登录时要不要把验证码发给智能体？**  
A：不要。CLI 自己打开 `/device`；用户只需在已登录的浏览器里点批准。不要发送密码、验证码、Cookie 或 token。

**Q：SSH 或容器里没有浏览器怎么办？**  
A：`MUVLOOM_NO_BROWSER=1 muvloom auth login --no-wait`，把打印出的 `verification_uri_complete` 在你自己的电脑浏览器打开，然后在原环境再跑 `muvloom auth login` 等待。

**Q：为什么 4K 被拒？**  
A：这是会员门闩 `PLAN_REQUIRED`，不是模型坏了。改用 `--image-size 1K` 或 `2K`，或开通会员后再试。

**Q：GIF 能带参考图吗？**  
A：不能。原生 GIF / SVG 都不接受 `--ref`。网站上有参考图时，「动图 GIF」和「矢量 SVG」会置灰。需要「按我这张图来做动画」时，Skill 的 `animation.md` 要求先说明：应改用本地工具处理，或先用普通图生图再本地成片——那不是 CLI 的原生 GIF 路径。

**Q：等待超时了，图还在跑吗？**  
A：是。`wait_timed_out: true` 时继续 `jobs wait` 同一个 `job_id`。

**Q：如何取消？会退积分吗？**  
A：`muvloom jobs cancel JOB_ID`。排队中或运行中会停止并退回积分。已经 `persisting` 的不能取消。

**Q：Skill 装了但聊天里看不到 `/muvloom`？**  
A：刷新宿主的技能列表或重开会话。不要编造宿主并未注册的斜杠别名。自然语言提到「幕芽」在支持的宿主里仍可能自动选中 Skill。

**Q：豆包 / WorkBuddy 怎么装？**  
A：不要运行 `muvloom skill install --host workbuddy` 或 `--host doubao`，当前 CLI 会报 USAGE。WorkBuddy 看 `/cli/workbuddy.md`；豆包在其客户端上传技能。

**Q：测试环境和生产环境能共用一次登录吗？**  
A：不能默默混用。连错服务会 `SERVICE_MISMATCH`。测试站请设置 `MUVLOOM_API_URL=https://test-api.muvloom.online`。

---

## 13. 相关文件（供维护者）

- CLI 入口与命令表：`cli-go/internal/cli/app.go`、`help.go`、`images.go`、`auth.go`、`skill.go`
- Skill 正文：`cli-go/internal/skill/assets/SKILL.md` 及 `references/*.md`
- 网站接入：`apps/web/src/features/cli/connectAgents.ts`、`CliConnectPage.tsx`、`CliDevicePage.tsx`
- 智能体安装指南：`apps/web/public/cli/setup.md`、`workbuddy.md`
- 服务端：`apps/bff/src/routes/cli.ts`、`apps/bff/src/lib/cli/*`
- 2.6 积分与拒绝原因：`packages/shared/src/gpt-image-26.ts`
