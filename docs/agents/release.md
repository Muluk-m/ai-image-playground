# Agent 发布手册

Agent 从 PR 到上线的完整链路，以及每一步谁能拍板。命令与内部机制以下面这些文档为准，本文只把顺序和审批点串起来，不重复它们：

- [部署手册](../deploy/image-release.md)：生产 workflow、Pages、镜像、排空与回滚
- [测试环境手册](../deploy/test-environment.md)：`test` 分支、独立数据库与 R2
- [私有 overlay 与版本](private-overlay.md)：`private.lock`、`verified` 指针、合并顺序
- [智能体上线手册](../deploy/agent-rollout.md)：改 `app.env` / `operator-config.json`、单价、冒烟
- [生产只读排查](prod-readonly.md)：Sentry、日志、配置名，以及禁止的写操作

## 谁拍板

合并 PR 与发布生产须所有者（Nain）明确批准，见仓库根 [AGENTS.md](../../AGENTS.md)「代码库归你」。检查、CI、评审齐了就停，不要自行合并、打生产或 CLI 发布标签，也不要自行回滚上线。Codex 30 分钟没回复只在 PR 里注明超时，不据此合并。获准合并并上线之后必须冒烟（见「四、上线核对」）。冒烟不过或出事故先停下并报告，等批准再按「五、回滚」合并 revert 或再发生产。推 `test` 发测试环境不是生产发布。绕过流水线、直接动生产服务器或生产数据仍然要 Nain 批准。2026-11-08「不等 Nain 批准」让位给这一条。

| 步骤 | 谁拍板 | 说明 |
| --- | --- | --- |
| 修 bug、功能或行为变更的 PR 合并 main（会发生产） | **需 Nain 批准** | 检查见「合并前检查」；涉及成本的要在描述和汇报里写清成本影响。检查齐了就停 |
| 带数据库迁移的 PR 合并 main | **需 Nain 批准** | 迁移必须兼容新旧两代后端并带回滚 SQL；改编号前按 AGENTS.md 先查两个库已跑过的迁移 |
| 私有 overlay 仓合并 | **需 Nain 批准** | 合并即发生产，并跑私有迁移 |
| 发布 CLI（打 `cli-vX.Y.Z` 标签） | **需 Nain 批准** | 见 [CLI 发布](cli-release.md)；发布后先用官方安装脚本试装，再改接入页钉的版本 |
| 生产回滚（revert PR、前端回滚） | **需 Nain 批准** | 冒烟不过或出事故时先报告现象、影响和建议回滚目标，批准后再合并 revert 或再发生产 |
| 重跑失败的 Deploy production job | Agent | 只重跑已经批准的那一单里失败的 job，不重跑整单，也不新开一版发布 |
| 绕过流水线手动发布 | **需 Nain 批准** | 正常路径是合并 main 自动发布 |
| 改服务器上的 `app.env` / `operator-config.json` | **需 Nain 批准** | 手工改，先备份，见下文 |
| 重启、重建、停止生产容器 | **需 Nain 批准** | 包括 `app-compose.sh up` |
| 共享 segmenter 的 `up` / `rollback` / `detach` | **需 Nain 批准** | 全部部署共用一个实例 |
| 推 `test` 分支发测试环境 | Agent | 测试环境独立，但调用真实供应商，花的是真钱 |

## 一、PR 与合并前检查

1. 从最新 `origin/main` 拉工作分支，不在 `main`、`test` 上直接改。提交与 PR 标题按 AGENTS.md「提交规范」（Conventional Commits，描述用中文）。
2. 按 AGENTS.md「完成任务的硬性检查清单」跑格式化、lint、typecheck 与测试；重任务交给云端或 CI。
3. 开 PR，按 [PR 模板](../../.github/pull_request_template.md) 填写。改到关键流程要附证据（AGENTS.md「关键流程证据」）；涉及成本要在「成本与影响」写清改了什么、对成本的影响（AGENTS.md「成本与影响说明」）。
4. 合并前三项缺一不可：
   - **CI 全绿**：`Web checks` 等 PR 上的检查都通过（`Cost impact` 只打标签提示，不拦合并）。main 没有分支保护和必需检查（2026-10-27 已定先不加：`overlay-bump.yml` 直接往 main 推 overlay 指针，必需检查会把它拦下），所以这条只靠流程守，紧急修复也要等 CI 全绿。
   - **`/review`**：在 PR 评论 `/review` 触发 AI Code Review（`.github/workflows/ai-review.yml`，不阻断合并），处理其中的有效意见。
   - **`@codex review`**：在 PR 评论 `@codex review`，处理有效意见。评论后 30 分钟仍没有回复就在 PR 里注明「Codex 30 分钟未回复」，不据此合并。
5. 检查齐了就停。所有者明确批准后才用 squash merge，合并说明用中文（见上表）；合并后跟进部署并冒烟。

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

## 三、生产发布（合并 main）

合并 `main` 就是发生产，不需要也不应该再手动发布：

1. `main` 上的 `Web checks` 通过后，`.github/workflows/deploy.yml`（Deploy production）经 `workflow_run` 自动开始，同一时间只跑一单（并发组 `production-deploy`）。
2. `target` 判定哪些部分要发（共享 muvloom API、muvloom Pages 项目、Admin）；产品前端扫描 `PAID_PUBLIC_ORIGIN`，同一项目的全部产品域名随之更新。已在跑后代提交的部分不回退；`release` 打 `vMAJOR.MINOR.PATCH` 标签。
3. **后端只构建和发布 muvloom runtime。** `backend` 在 Actions 用 `build-vps-release.sh paid` 构建公开树加私有 overlay 的发布镜像，以及 backup、segmenter 配套镜像，经 SSH 受限命令执行 `deploy <id> paid <run>`；`rollout-runtime.sh` 先跑兼容迁移，再做新旧两代排空切换。生产目标只有 `paid`，隔离测试目标为 `test`。
4. `pages-muvloom`（显示名 `Pages (muvloom project, every product domain)`）只发布一个 muvloom Pages 项目：一个项目、多个域名（`muvloom.online`、`image.nainma.online`、企业域名 `image-playground.qiliangjia.one`）。`pages-release.sh muvloom` 把 `ENTERPRISE_PUBLIC_ORIGIN → ENTERPRISE_BFF_BASE_URL` 并入 `baseUrlsByOrigin`，并给企业域名加 host 级 `X-Robots-Tag: noindex`。API 本次发布时，先等共享 muvloom API 与企业 API hostname `/health` 报出新版本，再发布并跑 Chromium 验收；企业域名在 muvloom 项目的 Cloudflare 自定义域名列表中时同样验收且失败即失败，未绑定只告警，不能据此宣称企业站已交付。`admin-pages` 保留对 `pages-muvloom` 的成功 / 跳过依赖。
   - 企业站使用 `ENTERPRISE_BFF_BASE_URL` 的第一方 hostname，不能直接配置为跨站 muvloom API，否则 `SameSite=Lax` cookie 登录失效。登录方式由后端 `AUTH_LOGIN_METHODS_BY_ORIGIN` 按 origin 决定（企业域名只飞书，muvloom 邮箱 + Google），前端不按域名分支。
   - 只改前端时，`pages-muvloom` 允许 backend job 跳过；只改后端时，backend 直接发布共享 muvloom API。Pages 与 Admin 都使用 muvloom 令牌。GitHub `PAGES_ENV`、仓库外 `pages.env` 的企业键名，以及 VPS 固定 receiver/runtime 必须配套更新，见[部署手册](../deploy/image-release.md#仓库外更新前提)。域名与 API 别名的维护及真实登录验收见[企业域名与 API 别名](../deploy/image-release.md#企业域名与-api-别名)。浏览器启动冒烟不替代真实登录与业务验收。
   - 失败后的重跑：同一发布 ID 已接收后只能按失败 job 重跑，不能重跑整单，避免同一发布目录冲突。

Agent 合并后只跟进这个 workflow 的结果，失败就看日志处理（可按失败 job 重跑），不手动补发。走应急手动发布要 Nain 批准。

### 私有 overlay 发布

私有 overlay 仓合并后，overlay CI 全绿就把 `verified` 指针前移；`.github/workflows/overlay-bump.yml` 每 10 分钟检查一次，构建「公开 main + 新 overlay」通过后把 `private.lock` 提交到 `main`，并直接触发 Deploy production。所以：

- **合并私有 overlay 就会发生产，并在发布里跑私有迁移。** 检查齐了就停，所有者明确批准后再合并；上线后冒烟。
- overlay 需要新的宿主面成员时，先把公开树的改动合进 `main`，再合 overlay，顺序反了 overlay CI 会红，`verified` 停在旧版。细节见[私有 overlay 与版本](private-overlay.md)。

## 四、上线核对

发布 workflow 绿了还不算交付完成，要核对线上真的是这个提交：

```sh
# API：共享 runtime 的 version 为 <公开sha>+<私有sha>，release 是产品版本
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

冒烟不过或出事故时先停下并报告现象、影响范围和建议回滚到的提交或镜像。等所有者明确批准，再合并 revert 或再发生产。不要自行回滚上线。需要在服务器上手工操作的（改 `operator-config.json`、`app-compose.sh up`、VPS 上的镜像回滚、前端 `pages-release.sh` 回滚）仍要 Nain 批准。

**先止血，再回滚。** 出问题的是单个功能或单个模型时，关掉它往往比回滚整个版本更快、波及更小。关能力开关、下架模型、改 `operator-config.json` 都是生产写操作，先等所有者批准，再按下面的步骤做：

- **关能力开关**：能力在服务器上的 `operator-config.json` 的 `capabilities` 里（求值见 `apps/bff/src/lib/capabilities.ts`），一律 deny by default。把出问题的能力改成 `false`，按[智能体上线手册「十、回滚」](../deploy/agent-rollout.md)的方式先备份再 `scripts/app-compose.sh up <project>`。配置写坏服务会拒绝启动而不是降级（[ADR 0001](../adr/0001-capability-config-fails-closed.md)），改完先校验 JSON。
- **下架模型**：在 Admin 的「模型」页把出问题的模型切到下架，写进公开库 `model_availability`（`apps/bff/src/lib/model-availability.ts`），页面和服务端都不再提供它，不用重新发布。
- 止血之后照样按下面的方式回滚或修复，并在汇报里写明止血做了什么、什么时候恢复。

- **常规**：开一个 revert PR，走正常检查。检查齐了后等所有者批准再合并，由 Deploy production 发出。它是新提交，不会被「不回退」规则跳过。
- **后端紧急回滚**：在 VPS 上用当前发布目录执行 `scripts/app-compose.sh rollback <project> <旧镜像>`。禁止用 `compose up --force-recreate`、`compose down` 或强停脚本绕过排空。数据库不会跟着回滚，迁移本来就要兼容新旧版本。见[部署手册「回滚与失败处理」](../deploy/image-release.md#回滚与失败处理)。
- **前端回滚**：在独立检出恢复上一个已验证的公开/私有提交，用同样的生产配置重跑对应的 `scripts/pages-release.sh`，再按「上线核对」验收。
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
