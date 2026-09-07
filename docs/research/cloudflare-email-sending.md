# Cloudflare Email Sending 可用性调研

- **调研日期**：2026-09-08
- **调研方式**：以 `developers.cloudflare.com/email-service/` 及其子页、Cloudflare 官方博客、Resend / AWS SES 官方定价页为一手来源逐条核实。本机 `~/.claude/skills-parked/cloudflare-email-service/` 的整理仅用作线索，凡与官方页面冲突处以官方为准并已在文中标注。

## 结论摘要

1. **能用**：Email Sending 已进入 public beta，且**官方提供 REST API 与 SMTP 两条通道**，Bun + Elysia 的 BFF 可以直接调用，**不需要 Worker 中继**。
2. **免费额度要打折看**：3,000 封/月的额度**挂在 Workers Paid 计划上**（$5/月起），Workers Free 计划只能发给「已验证的目的地址」，对注册验证码这种发给任意用户的场景等于不可用。所以 CF 的实际底价是 $5/月 + 超出部分 $0.35/1,000 封。
3. **怎么接**：发信 adapter 走 SMTP（nodemailer + `smtp.mx.cloudflare.net:465`，用户名固定 `api_token`）最省事且最容易在 CF / Resend / SES 之间切换；但**发往中国大陆邮箱（QQ / 163）的送达率官方完全无说明**，这是本方案最大的未知数。

## 项目约束

- **发信方是 BFF**，Bun + Elysia，跑在 Docker 或裸机上，**不是 Cloudflare Worker**。因此只能走 REST API 或 SMTP；若服务商只提供 Workers binding，就必须额外部署一个 Worker 当中继。
- **部署形态多样**：没有配置发信服务商的部署必须照常跑起来。发信能力是可选的，`adapter` 必须可插拔可关闭（与仓库既有的 `bff.enabled` 能力开关同构）。
- **收件人跨境**：既有中国大陆邮箱（QQ / 163），也有海外邮箱（Gmail）。大陆邮箱的送达率是选型的硬指标。
- **用途**：注册验证码、密码找回、返利到账通知——全部是事务邮件，无营销/群发需求（这点正好符合 CF 的使用条款，见第 5 条）。

---

## 1. 产品状态与计划要求

**状态：public beta**（不是 GA，也不是 private beta）。

Cloudflare 官方博客 *Email for agents — Cloudflare Email Service now in public beta* 记录 Email Sending 于 **2026 年 4 月 16 日**从 private beta 升级为 public beta。文档首页导航中该条目仍标注 "Email Sending **Beta** for outbound transactional emails — Available on Workers Paid plan"。

**计划要求：发给任意收件人需要 Workers Paid 计划。** 定价页原文：

> Sending to arbitrary recipients requires the Workers Paid plan.

Workers Free 计划只能发给账号内「已验证的目的地址」（verified destination addresses），即 Email Routing 里验证过的那几个自有邮箱。文档首页横幅：

> Sending to verified destination addresses in your account is free on all plans, even when only Email Routing is configured.

对本项目而言，验证码要发给任意注册用户，**Workers Paid 是硬门槛**。Workers Paid 的底价为：

> minimum charge of $5 USD per month for an account

引用：
- https://developers.cloudflare.com/email-service/ （查阅于 2026-09-08）
- https://blog.cloudflare.com/email-for-agents/ （公告日期 2026-04-16，查阅于 2026-09-08）
- https://developers.cloudflare.com/email-service/platform/pricing/ （查阅于 2026-09-08）
- https://developers.cloudflare.com/workers/platform/pricing/ （查阅于 2026-09-08）

---

## 2. 免费额度与单价

| 项目 | 数值 |
|---|---|
| 每月包含量 | **3,000 封/月**（按 Cloudflare 订阅账单周期重置，按账号计） |
| 超出单价 | **$0.35 / 1,000 封** |
| 前置成本 | Workers Paid **$5/月**（账号级最低消费） |
| 发给已验证目的地址 | **免费，且不计入包含量**（所有计划） |
| 入站 Email Routing | **Unlimited**，免费 |
| 每日额度 | 无公开数字，新账号从保守配额起步并随信誉自动提升 |

定价页原文：

> 3,000 included per month, then $0.35 per 1,000 emails

> Sends to verified destination addresses are free and do not count toward the included quota.

关于每日额度，限制页原文：

> New accounts start with a conservative daily quota and scale up over time based on your sending behavior, deliverability rates, and account standing.

**没有找到任何「beta 期间免费」的临时政策。** 定价页对 Email Sending 的收费规则是直接生效的，未提及 beta 期间豁免。

硬退信（hard-bounce）的邮件**也计入配额**（"Emails that hard-bounce or are otherwise accepted by Email Service count toward the quota"）。

引用：
- https://developers.cloudflare.com/email-service/platform/pricing/ （查阅于 2026-09-08）
- https://developers.cloudflare.com/email-service/platform/limits/ （查阅于 2026-09-08）

---

## 3. REST API 与 SMTP（从非 Workers 环境发送）

**结论：有 REST API，也有 SMTP，两条都能从任意后端调用，不需要 Worker 中继。**

### 3.1 REST API

- **端点**：`POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`
- **另有** `POST /accounts/{account_id}/email/sending/send_raw`（直接投递 raw MIME）
- **鉴权**：`Authorization: Bearer <API_TOKEN>`
- **Token 权限 scope**：**`Email Sending: Edit`**
- **文档明确**："No Cloudflare Workers binding is required."

请求体字段（注意与 Workers binding 的命名差异）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to` | string \| string[] | 是 | 收件人，与 cc/bcc 合计最多 50 |
| `from` | string \| `{address, name}` | 是 | 对象形式用 **`address`**，不是 `email` |
| `subject` | string | 是 | |
| `html` / `text` | string | 至少一个 | 建议都带，利于反垃圾评分 |
| `cc` / `bcc` | string \| string[] | 否 | |
| `reply_to` | string \| `{address, name}` | 否 | **snake_case** |
| `attachments` | array | 否 | base64 `content` + `filename` + `type` + `disposition` |
| `headers` | object | 否 | 自定义头，合计 16 KB |

响应：

```json
{
  "success": true,
  "errors": [],
  "messages": [],
  "result": {
    "delivered": ["recipient@example.com"],
    "permanent_bounces": [],
    "queued": []
  }
}
```

OpenAPI 资源页还列出 `suppressed_recipients` 与 `message_id` 字段，以及配套的抑制名单端点（`/email/sending/suppressions`，支持增删查与批量导入）和子域管理端点（`/email/sending/subdomains`）。

> ⚠️ **与本机整理的冲突**：parked skill 的 `references/deliverability.md` 给出的抑制名单路径是 `/email/sending/suppression`（单数），而官方 OpenAPI 资源页用的是 `/email/sending/suppressions`（复数）。以官方为准，实际接入时按 OpenAPI 页核对。

### 3.2 SMTP（推荐给本项目）

对 Bun + Elysia 的 BFF，SMTP 反而是最省事的一条——nodemailer 直接可用，且换 Resend / SES 时只需换 host 和凭据，adapter 抽象最薄。

- **主机端口**：`smtp.mx.cloudflare.net:465`
- **TLS**：**Implicit TLS（SMTPS）**。不支持 587 端口的 STARTTLS，也不支持 25 端口明文
- **认证**：SASL `AUTH PLAIN` 或 `LOGIN`
  - 用户名：**字面量字符串 `api_token`**
  - 密码：具有 `Email Sending: Edit` 权限的 Cloudflare API token
- **会话限制**：`RCPT TO` 每会话 50 个收件人；EHLO 通告 `SIZE` 为 5 MiB；`AUTH` 超时 30 秒；`DATA` 超时 300 秒
- 官方明确支持 "any application, framework, or off-the-shelf mail client that speaks SMTP"，点名 Nodemailer、`smtplib`、PHPMailer、JavaMail

官方 curl 示例：

```sh
curl --ssl-reqd \
  --url "smtps://smtp.mx.cloudflare.net:465" \
  --user "api_token:<API_TOKEN>" \
  --mail-from "welcome@yourdomain.com" \
  --mail-rcpt "recipient@example.com" \
  --upload-file mail.txt
```

### 3.3 Worker 中继

**不需要。** 仅在你希望把 API token 收到 CF 边缘、不下发到 BFF 环境时才有意义，本项目无此需求。

引用：
- https://developers.cloudflare.com/email-service/api/send-emails/rest-api/ （查阅于 2026-09-08）
- https://developers.cloudflare.com/email-service/api/send-emails/smtp/ （查阅于 2026-09-08）
- https://developers.cloudflare.com/api/resources/email_sending/ （查阅于 2026-09-08）

---

## 4. 域名要求与 onboarding

**发件域名必须托管在 Cloudflare DNS 上。** get-started 页原文：

> You must be using Cloudflare DNS to use Email Service.

即域名要是 Cloudflare 上的 zone（使用 Cloudflare 作为权威 DNS），不是「指过来就行」。

**onboarding 步骤（Dashboard）**：

1. 进入 **Compute** > **Email Service** > **Email Sending**
2. 选择 **Onboard Domain**，从账号内的域名中挑一个
3. 确认自动添加的 DNS 记录（MX、SPF、DKIM、DMARC）
4. **Done**

**DNS 自动配置**：是。文档原文：

> Cloudflare can configure all required DNS records for you when you onboard a domain onto Email Sending or Email Routing.

SPF、DKIM、DMARC 均在自动配置范围内。

> ⚠️ **与本机整理的冲突**：parked skill 反复提到 `npx wrangler email sending enable <domain>` 和 `wrangler email sending list` 作为 onboarding 手段。**官方 get-started 页没有出现这两个命令**，只给了 Dashboard 流程，Wrangler 部分仅涉及 Worker 侧的 `send_email` binding 配置：
> ```toml
> [[send_email]]
> name = "EMAIL"
> remote = true
> ```
> 这类 CLI 子命令可能存在但未进 get-started，也可能已改名/移除。**接入前以 `wrangler email --help` 实测为准，不要照抄 skill 里的命令。**（见「未核实」第 3 条）

另注：每个 zone 最多配置 **30** 个域名（Email Routing 与 Email Sending 合计）。

引用：
- https://developers.cloudflare.com/email-service/get-started/send-emails/ （查阅于 2026-09-08）
- https://developers.cloudflare.com/email-service/llms-full.txt （查阅于 2026-09-08）
- https://developers.cloudflare.com/email-service/platform/limits/ （查阅于 2026-09-08）

---

## 5. 限制

| 限制项 | 数值 | 备注 |
|---|---|---|
| 收件人数（to + cc + bcc） | **50 / 封** | 各字段合计 |
| 单封消息总大小 | **5 MiB** | 含附件 |
| 单封消息总大小（仅发给已验证地址） | **25 MiB** | |
| 附件 | 无独立限制 | 计入消息总大小 |
| 主题行长度 | **998 字符** | RFC 5322 |
| 自定义头总大小 | **16 KB** | |
| 每 zone 域名数 | **30** | Routing + Sending 合计 |
| 每日发送额度 | **无公开数字** | 新账号保守起步，按信誉自动提升 |
| 速率限制（QPS / RPM） | **文档未给出数值** | |

**收件人限制与 beta 无关，与计划有关**：Workers Free 只能发给已验证目的地址，Workers Paid 可发给任意收件人。**没有找到「beta 期间只能发给已验证地址」这类额外的 beta 专属限制。**（本机 skill 未提及此事；某些二手资料把「Free 计划限制」误读成「beta 限制」，需注意区分。）

**内容审核 / 使用条款**：FAQ 明确限定用途：

> Email Service is intended only for transactional emails. We plan to support marketing emails and bulk sender tooling in the future.

本项目的验证码、密码找回、返利到账通知**均属事务邮件，符合条款**。是否有自动化内容扫描/审核，官方文档未说明。

提高限额需填写官方的 Limit Increase Request Form（限制页内有 Google Forms 链接）。

引用：
- https://developers.cloudflare.com/email-service/platform/limits/ （查阅于 2026-09-08）
- https://developers.cloudflare.com/email-service/reference/faq/ （查阅于 2026-09-08）
- https://developers.cloudflare.com/email-service/platform/pricing/ （查阅于 2026-09-08）

---

## 6. 送达率

**官方明确不做送达保证。** deliverability 页原文：

> When you send an email, there is no guarantee it reaches the recipient's inbox.

**Cloudflare 托管的部分**：
- IP 信誉由 Cloudflare 托管（"Managed sending infrastructure optimized for deliverability"）
- 硬退信地址自动进抑制名单
- 软退信自动指数退避重试
- 反馈环（feedback loop）处理 ISP 投诉信号

**建议监控阈值**（官方给出）：送达率 > 95%，硬退信率 < 2%，投诉率 < 0.1%。

**共享 IP 还是独立 IP：官方无说明。** deliverability 页未提及 shared / dedicated IP，也未提供 IP 预热（warm-up）相关说明。

**中国大陆邮箱（QQ / 163）：官方无说明。** deliverability 页点名提及的邮箱服务商只有 **Gmail、Yahoo、Outlook、iCloud**，全文未出现 QQ、163、NetEase、Tencent 或 China 字样。**没有任何一手来源可以支撑「CF 发大陆邮箱好用」或「不好用」的结论**——这是必须实测的空白（见「未核实」第 1 条）。

引用：
- https://developers.cloudflare.com/email-service/concepts/deliverability/ （查阅于 2026-09-08）

---

## 7. 对比基线：Resend 与 Amazon SES

| 服务商 | 免费额度 | 最低价 / 单价 | 前置成本 |
|---|---|---|---|
| **Cloudflare Email Sending** | 3,000 封/月（**需 Workers Paid**）；发给已验证地址免费 | $0.35 / 1,000 封 | **$5/月**（Workers Paid 账号最低消费） |
| **Resend** | **3,000 封/月，且限 100 封/天**（真·免费，无订阅门槛） | Pro $20/月含 50,000 封 | $0 |
| **Amazon SES** | 无独立免费额度；新账号 $200 AWS Free Tier credits，6 个月内有效 | **$0.10 / 1,000 封**（à la carte）；附件 $0.12/GB | $0 |

要点：

- **CF 的 3,000 封「免费」是有 $5/月门票的**，等效单价在低量时并不占优。
- **Resend 免费档卡每天 100 封**，对验证码这种波动型流量是硬约束（注册高峰可能一天就打满），但零门票、接入最快。
- **SES 单价最低（$0.10/1,000）**，规模上来后最省，代价是开户/脱离沙箱（sandbox）需要申请、配置比前两者重。

引用：
- https://developers.cloudflare.com/email-service/platform/pricing/ （查阅于 2026-09-08）
- https://resend.com/pricing （查阅于 2026-09-08）
- https://aws.amazon.com/ses/pricing/ （查阅于 2026-09-08）

---

## 建议

前提：无论选哪个，**发信 adapter 都要抽象成可插拔接口**（`sendMail(to, subject, html, text)`），未配置服务商时整条链路降级为 no-op 或返回明确错误，保证未配置发信的部署照常跑。三个方案的差异只在 adapter 的实现与运维成本。

**A. 直接用 Cloudflare REST API / SMTP**
代价：必须开 Workers Paid（$5/月）、发件域名必须迁到 Cloudflare DNS，且**大陆邮箱送达率完全无一手数据、需自行实测**；产品仍在 public beta，接口与配额可能变动。

**B. Worker 中继**
代价：**本项目没有理由选它**——REST API 与 SMTP 已可从任意后端直连，加一层 Worker 只增加部署件和故障点。仅当你想把 API token 锁在 CF 边缘、不下发到 BFF 环境时才值得。

**C. 换 Resend 或 SES**
代价：Resend 零门票、接入最快、文档最好，但免费档 **100 封/天**的上限对注册高峰是真约束，升档即 $20/月；SES 单价最低、规模化最省，但需要申请脱离 sandbox、IAM 与配置心智负担最重。两者对大陆邮箱同样没有官方承诺，但第三方实践资料远多于 CF。

**倾向性判断（供裁决参考）**：若已有域名在 Cloudflare 且不介意 $5/月，A 的接入成本与 C 相当，还顺带拿到入站 Email Routing；但**大陆邮箱送达是本项目的核心指标，而 CF 在这点上是完全的未知数**，稳妥做法是**先按 C（Resend）跑通 adapter 与业务链路，同时用 A 做一次小规模真实投递实测**（见下节第 1 条），拿到数据再决定主用哪家。adapter 抽象让这个切换是低成本的。

---

## 未核实

以下各点官方文档没写清楚，**需要实测或进一步确认，不要基于推测决策**：

1. **【最高优先级】发往 QQ / 163 / 126 等中国大陆邮箱的实际送达率**。官方零说明。必须用真实大陆邮箱做小批量投递实测（收件箱 vs 垃圾箱 vs 直接被拒），CF / Resend / SES 三家横向对比。这条不解决，选型就是赌。
2. **CF 是共享 IP 还是独立 IP、IP 段是否已被大陆邮件服务商列入黑名单**。官方无说明。与第 1 条相关联——若是共享 IP 且段位口碑差，大陆送达会很难看。
3. **`wrangler email sending enable` / `wrangler email sending list` 是否仍存在**。本机 parked skill 大量使用，但官方 get-started 完全未提，只给 Dashboard 流程。需 `wrangler email --help` 实测。
4. **新账号的初始每日额度具体数字**、以及"随信誉提升"的实际爬坡速度与周期。官方只说"conservative"，无数字。若初始额度低于注册高峰的日发送量，上线即出问题。
5. **API / SMTP 的速率限制（QPS / 并发连接数）**。限制页完全没给数值，只给了单封消息维度的限制。高并发注册场景下需要知道。
6. **抑制名单端点的准确路径**（`/suppressions` 复数 vs parked skill 写的 `/suppression` 单数），以及 zone 级端点是否同样存在。以 OpenAPI 页实测为准。
7. **是否有自动化内容扫描 / 审核**，以及验证码类邮件（含短随机串、链接）是否容易触发。FAQ 只声明"仅限事务邮件"，未说明技术执行手段。
8. **public beta 的 SLA 与变更策略**：beta 期间接口是否可能 breaking change、是否有正式 SLA。官方未说明。
9. **"verified destination address" 的验证流程**本身。定价页反复引用这个概念但未解释如何验证（推测走 Email Routing 的目的地址验证邮件流程，未证实）。
