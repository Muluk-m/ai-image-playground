# 幕芽 CLI / MCP 登录：竞品怎么把账号和生图接在一起

日期：2026-10-30。只记录能回到厂商文档或协议原文的做法。方案取舍见文末。

## fal

fal 把「人在终端登录」和「程序用密钥」分成两条。

- `fal auth login` 打开浏览器，可选 GitHub、Google 或企业 SSO；`--no-browser` 只打印网址。登出、`whoami` 配套。凭证存在本机。多人团队时登录过程里选默认团队。[CLI auth](https://fal.ai/docs/api-reference/cli/auth)
- 模型调用也可以只用 `FAL_KEY`。密钥在仪表盘创建，只显示一次，带权限预设；`API` 预设能提交和读取模型请求。密钥属于账号或团队，不是某个人随手贴进聊天里的字符串。[Key-based auth](https://fal.ai/docs/documentation/model-apis/authentication/key-based)、[Get your API key](https://fal.ai/docs/documentation/setting-up/authentication)
- 给编程助手用的是远程 MCP：`https://mcp.fal.ai/mcp-relay`，传输是 Streamable HTTP，认证是 OAuth 浏览器登录。官方写明这条连接不用创建 API key，也不把 key 写进配置。安装脚本会挂到 Claude Code、Codex、Cursor 等，跳过已经配过的，并且不写 key。文档搜索用另一个不碰账号的地址 `https://fal.ai/docs/mcp`。[MCP](https://fal.ai/docs/documentation/setting-up/mcp)

## Hugging Face

Hub 把 CLI、设备码和用户令牌放在同一套身份上。

- 可以建不带 client secret 的公开 OAuth 应用，给 CLI、原生应用和存不住密钥的环境用。也有设备码流程：一台设备显示短码，另一台设备的浏览器里确认，跑 CLI 的那台不必有浏览器。[Sign in with Hugging Face](https://huggingface.co/docs/hub/oauth)
- `hf auth login` 可以走浏览器，也可以粘贴 `huggingface.co/settings/tokens` 里的用户令牌。非交互的 agent 模式不弹提问，而是请用户打开 `verification_uri_complete` 并输入 `user_code`，然后自己轮询。[CLI 源码 `auth.py`](https://github.com/huggingface/huggingface_hub/blob/v1.33.0/src/huggingface_hub/cli/auth.py)

## Canva

Canva 把「结果留在用户自己的账号里」做成 MCP 的默认语义。

- Connect REST 用 OAuth 2.0 授权码 + PKCE（S256）。用户在 Canva 页面上批准 scope。[Authentication](https://www.canva.dev/docs/connect/authentication/)
- 远程 MCP（AI Connector 文档中的 `https://mcp.canva.com/mcp`，开发者接入文档中的 `https://api.canva.com/connect/v1/mcp`）要求每个用户用自己的 Canva 账号授权。工具权限等于这个人在 Canva 里的权限，不做组织级服务账号。生成和改动的是这个人账号里的设计与素材。[Canva MCP GA](https://www.canva.dev/blog/developers/canva-mcp-ga)、[Access and permissions](https://www.canva.dev/docs/apps/mcp/access/)

## Replicate 与 Leonardo

这两家是「仪表盘发密钥，调用记在该账号下，网页上能看见」。

- Replicate 只用 API token（`r8_`，`Authorization: Bearer`）。令牌在账号页创建、可禁用。预测属于该用户或组织；仪表盘列出的预测同时包含网站和 API 创建的。[API tokens](https://replicate.com/docs/topics/security/api-tokens)、[How Replicate works](https://replicate.com/docs/how-does-replicate-work)、[HTTP API：列出 predictions](https://replicate.com/api)
- Leonardo 在网页的 API Access 里创建 Production API key，用 Bearer 调 `POST /generations`。官方 FAQ 写明：API 生成的图不会过期，并且可以随时在 Web App 里打开。API 套餐和网页订阅是分开的。[Getting started](https://docs.leonardo.ai/docs/getting-started)、[API FAQ](https://docs.leonardo.ai/docs/api-faq)

## MCP 授权协议

HTTP MCP 的授权是传输层上的 OAuth 2.1，不是把密钥写进 `mcp.json`。

- 2025-11-25：MCP server 是资源服务器，客户端是 OAuth 客户端。服务器必须提供 Protected Resource Metadata（RFC 9728）；客户端用它发现授权服务器。客户端必须带 RFC 8707 的 `resource`，令牌绑在这个 MCP 资源上，不能拿去调别的服务。服务器转调上游时必须另要一张令牌，不能把客户端给它的令牌原样转发。[Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- STDIO 传输不走这套，改为从环境读凭证。[Overview](https://modelcontextprotocol.io/specification/2025-11-25/basic/index)

## 幕芽现状里和这件事相关的事实

- 网站现有 OAuth 是「用外部身份登录幕芽」（`/api/auth/oauth/:provider/start`），会话是 HttpOnly cookie。这不是「幕芽给 CLI 发令牌」。
- 素材表 `user_assets` 是用户点名留下的可复用素材（名称、封面、类别、视角），和一次生成不是同一条记录。见 `packages/db/src/schema.ts`。
- [ADR 0011](../adr/0011-cloud-storage-limited-to-assets.md) 把长期云端收在素材和会话上。生成产出不再扩大上云。每次 CLI 生图都自动写成一条永久素材，会直接踩这条成本边界。

## 对方案的含义

用户侧只做一件事：对 Agent 发一句提示词。Agent 自己安装幕芽 skill，skill 规定用本机 CLI 调幕芽接口，生成的图进这个账号的资产列表。

安装用现成的 skills CLI：`npx skills add <仓库> --skill muvloom -g -y`。它把 `SKILL.md` 写进 Claude Code、Codex、Cursor 等 Agent 的 skills 目录，支持 `-g` 装到用户目录、`-y` 不问询。[skills.sh CLI](https://www.skills.sh/docs/cli)、[npm skills](https://www.npmjs.com/package/skills)

skill 正文只写死这三步：未安装 CLI 就安装；`muvloom auth whoami` 失败就 `muvloom auth login`（浏览器点一次允许）；然后 `muvloom generate --prompt …`。CLI 拿本机令牌去调 `POST /v1/queue/:provider/:model/submit`。MCP 不在这条路径上。
