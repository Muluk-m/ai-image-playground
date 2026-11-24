# Agent 发布手册

Agent 从 PR 到上线的完整链路，以及每一步谁能拍板。命令与内部机制以下面这些文档为准，本文只把顺序和审批点串起来，不重复它们：

- [部署手册](../deploy/image-release.md)：生产 workflow、Pages、镜像、排空与回滚
- [测试环境手册](../deploy/test-environment.md)：`test` 分支、独立数据库与 R2
- [单仓与退役说明](private-overlay.md)：原双仓 overlay 收口为单仓后的能力开关与迁移背景
- [智能体上线手册](../deploy/agent-rollout.md)：改 `app.env` / `operator-config.json`、单价、冒烟
- [生产只读排查](prod-readonly.md)：Sentry、日志、配置名，以及禁止的写操作

## 谁拍板

经发布流水线上线的步骤由 Agent 自己推进，**不用等 Nain 确认**（2026-11-24 Nain 决定）：检查齐了、判断没问题就直接合并。合并不等于上线：生产发布按需手动，Nain 说发布后由 Agent 触发并跟进（回滚除外，见下表），**上线后必须冒烟**（见「四、上线核对」）；冒烟不过就修复或按「五、回滚」直接处理，并在汇报里说明。只有绕过流水线、直接动生产服务器或生产数据的手工操作仍要 Nain 批准，因为它们没有检查、也没有自动回滚。

| 步骤 | 谁拍板 | 说明 |
| --- | --- | --- |
| 修 bug、功能或行为变更的 PR 合并 main（合并后待发布，不自动上线） | Agent，检查齐了即可 | 检查见「合并前检查」；确认没问题即可直接 squash merge。涉及成本或结算的要在描述和汇报里写清并标出影响 |
| 带数据库迁移的 PR 合并 main | Agent，检查齐了即可 | 迁移必须兼容新旧两代后端并带回滚 SQL；改编号前按 AGENTS.md 先查两个库已跑过的迁移 |
| 发布 CLI（打 `cli-vX.Y.Z` 标签） | Agent，检查齐了即可 | 见 [CLI 发布](cli-release.md)；发布后先用官方安装脚本试装，确认安装与版本正常 |
| 生产常规回滚（revert PR） | Agent | 冒烟不过或出事故时直接开 revert PR 合并，并触发 Deploy production 发出；事后在汇报里写清现象、影响和回滚目标 |
| 触发 Deploy production（发布当前 main） | **需 Nain 说发布**（回滚除外） | 一律走幂等入口 `scripts/release.sh [--include <sha>]`，禁止裸跑 `gh workflow run deploy.yml`。默认 `mode=incremental`；`full` 全部重发。Nain 说了发布，Agent 直接执行并跟进，不再另行确认 |
| 重跑失败的 Deploy production job | Agent | 只按失败 job 重跑，不重跑整单 |
| 绕过流水线手动发布 / 手工前端回滚（`scripts/pages-release.sh`） | **需 Nain 批准** | 正常路径是 Deploy production workflow；绕过它（macmini2 构建、手工上传）没有检查和自动回滚 |
| 改服务器上的 `app.env` / `operator-config.json` | **需 Nain 批准** | 手工改，先备份，见下文 |
| 重启、重建、停止生产容器 | **需 Nain 批准** | 包括 `app-compose.sh up` |
| 共享 segmenter 的 `up` / `rollback` / `detach` | **需 Nain 批准** | 全部部署共用一个实例 |
| 推 `test` 分支发测试环境 | Agent | 测试环境独立，但调用真实供应商，花的是真钱 |

## 一、PR 与合并前检查

1. 从最新 `origin/main` 拉工作分支，不在 `main`、`test` 上直接改。提交与 PR 标题按 AGENTS.md「提交规范」（Conventional Commits，描述用中文）。
2. 按 AGENTS.md「完成任务的硬性检查清单」跑格式化、lint、typecheck 与测试；重任务交给云端或 CI。
3. 开 PR，按 [PR 模板](../../.github/pull_request_template.md) 填写。改到关键流程要附证据（AGENTS.md「关键流程证据」）；涉及成本要在「成本与影响」写清改了什么、对成本的影响（AGENTS.md「成本与影响说明」）。
4. 合并前三项缺一不可：
   - **CI 全绿**：`Web checks` 等 PR 上的检查都通过。main ruleset 要求经 PR squash 合并且 `Web checks` 为必需检查（2026-11-22 起）。`PR rules` 不是必需检查，红了要补齐或在 PR 里说明理由交 Nain 决定。
   - **`/review`**：在 PR 评论 `/review` 触发 AI Code Review（`.github/workflows/ai-review.yml`，不阻断合并），处理其中的有效意见。
   - **`@codex review`**：在 PR 评论 `@codex review`，处理有效意见。评论后 30 分钟仍没有回复就继续，并在 PR 里注明「Codex 30 分钟未回复」。
5. 用 squash merge 合并，合并说明用中文。检查齐了、确认没问题即可直接合并，不用等 Nain 确认（见上表）；合并后跟进部署并冒烟。

## 二、测试环境（test 分支）

`test` 分支推上去就由 `.github/workflows/deploy-test.yml` 发布：先发测试后端 `image-playground-test`（`test-api.muvloom.online`，独立数据库 `aip_test` 与 R2 桶 `muvloom-test`），再发 https://test.muvloom.online。第一步 `scripts/ci-check-test-branch.sh` 检查 `test` 是否包含最新 `main`，落后就直接失败。

推 `test` 的规则：

- `test` 必须包含 `main`。从远端最新的 `test` 出发，把最新 `origin/main` 和工作分支合进去，再普通推送。对远端来说这是一次快进。
- 只用 fetch 加快进，不 force-push，不 rebase `test`。推送被拒说明别人刚推过，重新 fetch 后再合一次。
- 不在 `test` 上直接改代码，也不把 `test` 合回工作分支或 `main`。

```sh
git fetch origin
git switch -c test-push origin/test
git merge --no-edit origin/main
git merge --no-edit <工作分支>
git push origin HEAD:test
```

跟进 Deploy test 跑完，再核对测试站的版本并实测改动，见下面的「上线核对」。测试环境用真实供应商 key，生成照样花钱，冒烟控制在最小用量。测试通过不代表可以上生产。

## 三、生产发布（按需手动，幂等入口）

合并 `main` 不会上线。合并后的改动处于「待发布」，什么时候发由 Nain 决定；Nain 说发布（或回滚）时，所有 Agent 与人都统一走幂等入口 `scripts/release.sh`，**不要裸跑 `gh workflow run deploy.yml`**，避免多 Agent 并行时各自重复触发构建：

```sh
scripts/release-status.sh                                           # 只读：API、前端、Admin 各还差哪些改到自己的提交
scripts/release.sh --include <你的合并提交>                          # 推荐：若已在线跳过；若有在跑/排队单已包含则直接 watch；否则等 CI 绿后触发一单
scripts/release.sh --reason '…'                                     # 发布当前 origin/main（默认 incremental）
scripts/release.sh --mode full --reason '…'                         # 全部重发（不走跳过与复用）
scripts/release.sh --pin-sha --reason '…'                           # 锁死触发时刻的提交，不自动推进到排队期间的新 main
```

`scripts/release.sh` 内置四步去重：

1. **已在线跳过（`outcome=already_live`）**：`--include <sha>` 触及的每一边线上都已运行该提交或其后代（或全量线上已覆盖 `origin/main` 全部可发布改动）时直接退出。
2. **搭便车复用（`outcome=piggybacked`）**：若已有 `in_progress` 或 `queued` 的 `Deploy production` 且其提交已包含 `--include`（或 `origin/main`），不发新单，直接 `gh run watch` 复用它。
3. **CI 门禁后再复查**：若 `main` 的 `Web checks` 尚未结束，先轮询等待变绿（失败则拒绝触发），通过后再做一次 1/2 复查，防并行会话在等待窗口内已发过单。
4. **单次触发并精确跟踪（`outcome=dispatched`）**：在本地原子锁内再复查一次线上与在途单，带唯一 `dispatch_id` 触发一次 `deploy.yml`，按 `display_title` 精确关联新 run ID 后释放锁并 `gh run watch`（加 `--no-watch` 只触发不阻塞；默认 watch 模式下超时未找到 run 会返回非零并提示人工查看，避免静默误报成功）。

workflow 本身的机制：

1. `.github/workflows/deploy.yml`（Deploy production）由 `workflow_dispatch` 触发，同一时间只跑一单（并发组 `production-deploy`，不取消在跑单，排队只留最新一单）。拿到发布锁后由 `scripts/ci-pick-release-sha.sh` 选定目标提交：**默认（`pin_sha=false`）自动推进到 `[触发提交, origin/main HEAD]` 中最新已通过 `Web checks` 的提交**，把排队期间合入且已过检的 PR 自动并进同一单；传 `pin_sha=true` 时锁死触发时刻的提交。若所选提交在 `main` 上的 `Web checks` 未通过或失败则直接报错。运行摘要在切换前按各部分线上实际版本列出本次带上的提交，冒烟按这份清单逐项核对。
2. `target` 判定哪些部分要发（共享 muvloom API、muvloom Pages 项目、Admin）；产品前端扫描 `PAID_PUBLIC_ORIGIN`，同一项目的全部产品域名随之更新。已在跑后代提交的部分不回退；`release` 打 `vMAJOR.MINOR.PATCH` 标签。
3. **后端只构建和发布 muvloom runtime。** `backend` 在 Actions 用 `build-vps-release.sh paid` 构建单仓发布镜像，以及 backup、segmenter 配套镜像，经 SSH 受限命令执行 `deploy <id> paid <run>`；`rollout-runtime.sh` 先跑兼容迁移，再做新旧两代排空切换。生产目标只有 `paid`，隔离测试目标为 `test`。
4. `pages-muvloom`（显示名 `Pages (muvloom project, every product domain)`）只发布一个 muvloom Pages 项目：一个项目、多个域名（`muvloom.online`、`image.nainma.online`、企业域名 `image-playground.qiliangjia.one`）。`pages-release.sh muvloom` 把 `ENTERPRISE_PUBLIC_ORIGIN → ENTERPRISE_BFF_BASE_URL` 并入 `baseUrlsByOrigin`，并给企业域名加 host 级 `X-Robots-Tag: noindex`。API 本次发布时，先等共享 muvloom API 与企业 API hostname `/health` 报出新版本，再发布并跑 Chromium 验收；企业域名在 muvloom 项目的 Cloudflare 自定义域名列表中时同样验收且失败即失败，未绑定只告警，不能据此宣称企业站已交付。`admin-pages` 保留对 `pages-muvloom` 的成功 / 跳过依赖。
   - 企业站使用 `ENTERPRISE_BFF_BASE_URL` 的第一方 hostname，不能直接配置为跨站 muvloom API，否则 `SameSite=Lax` cookie 登录失效。登录方式由后端 `AUTH_LOGIN_METHODS_BY_ORIGIN` 按 origin 决定（企业域名只飞书，muvloom 邮箱 + Google），前端不按域名分支。
   - 只改前端时，`pages-muvloom` 允许 backend job 跳过；只改后端时，backend 直接发布共享 muvloom API。Pages 与 Admin 都使用 muvloom 令牌。GitHub `PAGES_ENV`、仓库外 `pages.env` 的企业键名，以及 VPS 固定 receiver 必须配套更新（`paid` 与 `test` 的部署脚本均随发布从 main 自动解出，不需手工同步），见[部署手册](../deploy/image-release.md#仓库外更新前提)。域名与 API 别名的维护及真实登录验收见[企业域名与 API 别名](../deploy/image-release.md#企业域名与-api-别名)。浏览器启动冒烟不替代真实登录与业务验收。
   - 失败后的重跑：同一发布 ID 已接收后只能按失败 job 重跑，不能重跑整单，避免同一发布目录冲突。

合并后 Agent 在汇报里列出待发布的改动；Nain 说发布后触发 workflow、跟进到跑完，冒烟在发布完成后做。失败就看日志处理（可按失败 job 重跑），不绕过 workflow 补发。一次带上的改动越多，出问题越难定位：有关键流程或数据库迁移的改动，建议单独发布、单独冒烟。

### 计费与企业能力发布

双仓私有 overlay 机制已收口为单仓（见 [private-overlay.md](private-overlay.md)），计费与飞书身份模块随主仓一同通过 PR 审核、CI 门禁，随下一次生产发布上线，按 `operator-config.json` 的能力开关启用（`billing:credits` 等），不再维护独立的私有仓同步或 `overlay-bump.yml`。

## 四、上线核对

发布 workflow 绿了还不算交付完成，要核对线上真的是这个提交：

```sh
# API：共享 runtime 的 version 为 <sha>+<sha>（兼容旧 receiver 协议），release 是产品版本
curl -fsS https://api.muvloom.online/health
curl -fsS https://image-api.qiliangjia.one/health
curl -fsS https://test-api.muvloom.online/health

# 网页：企业与 muvloom 共用同一 version；版本相同不替代登录与业务验收
curl -fsS https://muvloom.online/version.json
curl -fsS https://image-playground.qiliangjia.one/version.json
curl -fsS https://admin.muvloom.online/version.json
curl -fsS https://test.muvloom.online/version.json
```

这些只读请求不需要审批。版本对上之后，再在浏览器里实测改到的功能；关键流程用测试账号，按 PR 模板留证据。

## 五、回滚

冒烟不过或出事故时由 Agent 直接开 revert PR 回滚（合并后触发 Deploy production 发出），事后在汇报里写清现象、影响范围和回滚到的提交或镜像。绕过流水线或需要在服务器上手工操作的（改 `operator-config.json`、`app-compose.sh up`、VPS 上的镜像回滚、手工重跑 `scripts/pages-release.sh` 做前端回滚）仍要 Nain 批准。

**先止血，再回滚。** 出问题的是单个功能或单个模型时，先关掉它，往往比回滚整个版本更快、波及更小：

- **关能力开关**：能力在服务器上的 `operator-config.json` 的 `capabilities` 里（求值见 `apps/bff/src/lib/capabilities.ts`），一律 deny by default。把出问题的能力改成 `false`，按[智能体上线手册「十、回滚」](../deploy/agent-rollout.md)的方式先备份再 `scripts/app-compose.sh up <project>`。配置写坏服务会拒绝启动而不是降级（[ADR 0001](../adr/0001-capability-config-fails-closed.md)），改完先校验 JSON。
- **下架模型**：在 Admin 的「模型」页把出问题的模型切到下架，写进公开库 `model_availability`（`apps/bff/src/lib/model-availability.ts`），页面和服务端都不再提供它，不用重新发布。
- 止血之后照样按下面的方式回滚或修复，并在汇报里写明止血做了什么、什么时候恢复。

- **常规**：开一个 revert PR，走正常检查后直接合并，由 Deploy production 发出。它是新提交，不会被「不回退」规则跳过。
- **后端紧急回滚**：在 VPS 上用当前发布目录执行 `scripts/app-compose.sh rollback <project> <旧镜像>`。禁止用 `compose up --force-recreate`、`compose down` 或强停脚本绕过排空。数据库不会跟着回滚，迁移本来就要兼容新旧版本。见[部署手册「回滚与失败处理」](../deploy/image-release.md#回滚与失败处理)。
- **前端回滚（手工绕过流水线）**：经 Nain 批准后，在独立检出恢复上一个已验证的提交，用同样的生产配置重跑对应的 `scripts/pages-release.sh`，再按「上线核对」验收。
- **segmenter 回滚**：`scripts/segmenter-deploy.sh rollback`，只能手动跑，会切所有部署，见下文。

每一次回滚（revert PR 或紧急回滚）都要在 [review-evals](review-evals.md) 加一条：原 PR、从哪个提交到哪个提交、评审本该看出什么，供以后改 ocr 模型或提示词前回放。

### 事故复盘模板

回滚或止血之后，在 revert PR 描述（没有 PR 的写进给 Nain 的汇报）里补一段：

```md
## 事故复盘

- 现象：用户看到了什么、从什么时候开始（时间写 UTC+8）、怎么发现的。
- 影响：影响了哪些用户、页面、接口或数据，持续多久，有没有数据要修。
- 哪一层本该拦住：自证（作者自测与子 Agent 复查）/ ocr / Codex / CI / 测试环境验收 / 发布核对，选一层或几层，说明为什么没拦住。
- 补在哪：为了下次拦住，改了哪份文档、哪条检查或哪个测试（附 PR 链接）；还没补的写清楚由谁什么时候补。
```

## 六、服务器上的配置与共享组件

- **`app.env` 里的供应商 key 只在服务器上。** 不进仓库、不进 GitHub secret、不贴进 PR 或对话。改它要 Nain 批准，在服务器上手工改，改之前先备份：

  ```sh
  d=~/.config/ai-image-playground/apps/<project>
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  cp -a $d/app.env $d/app.env.bak-<用途>-$ts
  ```

  `app.env` 是 compose 的 `env_file`，改完要重建（`./scripts/app-compose.sh up <project>`），`restart` 不会重读；重建也要 Nain 批准。恢复就把备份拷回去再重建。完整步骤见[智能体上线手册](../deploy/agent-rollout.md)第二节与回滚一节。
- **segmenter 全局只有一个实例** `image-playground-segmenter`，muvloom 生产与测试环境共用。`SEGMENTER_EDITIONS` 仅支持 `paid` / `test`。只有生产发布会 `up` 它；测试发布只 `attach`，从不构建、启动或替换。不要为某个环境单独起一份，也不要手动 `up`、`rollback`、`detach`。见 `scripts/segmenter-deploy.sh` 开头的说明和 [deploy/segmenter/README.md](../../deploy/segmenter/README.md)。
