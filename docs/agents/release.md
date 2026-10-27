# Agent 发布手册

Agent 从 PR 到上线的完整链路，以及每一步谁能拍板。命令与内部机制以下面这些文档为准，本文只把顺序和审批点串起来，不重复它们：

- [部署手册](../deploy/image-release.md)：生产 workflow、Pages、镜像、排空与回滚
- [测试环境手册](../deploy/test-environment.md)：`test` 分支、独立数据库与 R2
- [私有 overlay 与版本](private-overlay.md)：`private.lock`、`verified` 指针、合并顺序
- [智能体上线手册](../deploy/agent-rollout.md)：改 `app.env` / `operator-config.json`、单价、冒烟
- [生产只读排查](prod-readonly.md)：Sentry、日志、配置名，以及禁止的写操作

## 需要 Nain 批准的步骤

下表的「需 Nain 批准」指 Nain 本人在对话或 PR 里明确说可以。Agent 自己的判断、测试通过或 CI 全绿都不能代替。

| 步骤 | 谁拍板 | 说明 |
| --- | --- | --- |
| 修 bug 的 PR 合并 main（会发生产） | Agent，检查齐了即可 | 检查见「合并前检查」；涉及成本的要在描述和汇报里写清成本影响 |
| 功能或行为变更的 PR 合并 main（会发生产） | **需 Nain 批准** | 用户能感知的新功能、交互或默认行为变化，都算 |
| 带数据库迁移的 PR 合并 main | **需 Nain 批准** | 合并即在生产跑迁移，数据库不会自动回滚 |
| 私有 overlay 仓合并 | **需 Nain 批准** | 合并即发生产，并跑私有迁移 |
| 生产回滚（镜像回滚、前端回滚、revert PR） | **需 Nain 批准** | 紧急时先报告现象和建议的回滚目标，再等批准 |
| 手动触发 Deploy production、手动发布 | **需 Nain 批准** | 正常路径是合并 main 自动发布 |
| 改服务器上的 `app.env` / `operator-config.json` | **需 Nain 批准** | 手工改，先备份，见下文 |
| 重启、重建、停止生产容器 | **需 Nain 批准** | 包括 `app-compose.sh up` |
| 共享 segmenter 的 `up` / `rollback` / `detach` | **需 Nain 批准** | 全部部署共用一个实例 |
| 推 `test` 分支发测试环境 | Agent | 测试环境独立，但调用真实供应商，花的是真钱 |

## 一、PR 与合并前检查

1. 从最新 `origin/main` 拉工作分支，不在 `main`、`test` 上直接改。提交与 PR 标题按 AGENTS.md「提交规范」（Conventional Commits，描述用中文）。
2. 按 AGENTS.md「完成任务的硬性检查清单」跑格式化、lint、typecheck 与测试；重任务交给云端或 CI。
3. 开 PR，按 [PR 模板](../../.github/pull_request_template.md) 填写。改到关键流程要附证据（AGENTS.md「关键流程证据」）；涉及成本要在「成本与影响」写清改了什么、对成本的影响（AGENTS.md「成本与影响说明」）。
4. 合并前三项缺一不可：
   - **CI 全绿**：`Web checks` 等 PR 上的检查都通过（`Cost impact` 只打标签提示，不拦合并）。
   - **`/review`**：在 PR 评论 `/review` 触发 AI Code Review（`.github/workflows/ai-review.yml`，不阻断合并），处理其中的有效意见。
   - **`@codex review`**：在 PR 评论 `@codex review`，处理有效意见。评论后 30 分钟仍没有回复就继续，并在 PR 里注明「Codex 30 分钟未回复」。
5. 用 squash merge 合并，合并说明用中文。修 bug 的 PR 检查齐了即可合并；功能或行为变更、带迁移的 PR 要先等 Nain 批准（见上表）。

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
2. `target` 判定哪些部分要发（API、内部站、收费站、Admin），已在跑后代提交的部分不回退；`release` 打 `vMAJOR.MINOR.PATCH` 标签。
3. **先发内部版。** `backend` 在 Actions 构建两套镜像（经 GHCR），但只把内部版经 SSH 受限命令送到 VPS（`deploy <id> internal <run>`），`rollout-runtime.sh` 先跑兼容迁移（`bun run /app/apps/bff/src/db/migrate.ts`），再做新旧两代排空切换。随后 `pages-internal` 等内部 API 的 `/health` 报出新版本，发内部站并跑 Chromium 验收。
4. **内部版验收通过才发收费版。** 闸门有两项：内部 API 的 `/health` 报的是这次的提交；这次要发前端时，`pages-internal`（含 Chromium 验收）成功。都过了，`backend-paid` 才把同一份发布目录（同一批镜像 digest，不重新构建）以 `deploy <id> paid <run>` 送上 VPS，接着 `pages-paid` 发收费站并验收，最后 `admin-pages` 发后台前端。任何一项不过，收费版的后端和前端都不动，停在上一版；内部版已经发出去的不会自动撤回，按「五、回滚」处理。
   - 只改了前端（API 树没变）时，没有后端可发，`pages-paid` 只等 `pages-internal` 成功。
   - 只改了后端时，`pages-internal` 被跳过，闸门只剩内部 `/health`。
   - 发布时间：以前两站并行，现在收费版串在内部版之后。按 2026-10 的记录（构建约 4 分钟、两套一起送上 VPS 约 1.5–2 分钟、每个站 2 分钟左右），一次前后端都发的发布从约 10 分钟变成约 12–13 分钟；只发后端约多 1 分钟（多一个 job 和一次 SSH）。收费版在这段时间里比内部版晚几分钟上线。
   - 失败后的重跑：同一个 run 里 VPS 会收两次同一个发布 ID，第二次落在 `~/releases/<id>.run-<run_id>`。所以只能用「Re-run failed jobs」，不能用「Re-run all jobs」，后者会让内部那次撞上「Release directory already exists」。第三次收同一个 ID 也会撞上，所以失败的 job 如果已经把发布目录传上 VPS（日志里 receive 已完成），重跑它同样会失败，要先找 Nain。要放开这一点得改服务器上的 `aip-ci-receive`，要 Nain 批准。重跑本身也要 Nain 批准（见下）。

Agent 合并后只跟进这个 workflow 的结果，失败就看日志处理，不手动补发。手动重跑 Deploy production 或走应急手动发布要 Nain 批准。

### 私有 overlay 发布

私有 overlay 仓合并后，overlay CI 全绿就把 `verified` 指针前移；`.github/workflows/overlay-bump.yml` 每 10 分钟检查一次，构建「公开 main + 新 overlay」通过后把 `private.lock` 提交到 `main`，并直接触发 Deploy production。所以：

- **合并私有 overlay 就会发生产，并在发布里跑私有迁移。** 合并前要 Nain 批准。
- overlay 需要新的宿主面成员时，先把公开树的改动合进 `main`，再合 overlay，顺序反了 overlay CI 会红，`verified` 停在旧版。细节见[私有 overlay 与版本](private-overlay.md)。

## 四、上线核对

发布 workflow 绿了还不算交付完成，要核对线上真的是这个提交：

```sh
# API：version 是公开提交；收费版是 <公开sha>+<私有sha>，release 是产品版本
curl -fsS https://api.muvloom.online/health
curl -fsS https://image-api.qiliangjia.one/health
curl -fsS https://test-api.muvloom.online/health

# 网页：version 形如 <公开短sha>[+<私有短sha>]-<构建时间>，短 sha 要和 API 的提交对上
curl -fsS https://muvloom.online/version.json
curl -fsS https://image-playground.qiliangjia.one/version.json
curl -fsS https://admin.muvloom.online/version.json
curl -fsS https://test.muvloom.online/version.json
```

这些只读请求不需要审批。版本对上之后，再在浏览器里实测改到的功能；关键流程用测试账号，按 PR 模板留证据。

## 五、回滚（需 Nain 批准）

先报告现象、影响范围和建议回滚到的提交或镜像，Nain 批准后再动手。

**先止血，再回滚。** 出问题的是单个功能或单个模型时，先关掉它，往往比回滚整个版本更快、波及更小。止血同样要 Nain 批准：

- **关能力开关**：能力在服务器上的 `operator-config.json` 的 `capabilities` 里（求值见 `apps/bff/src/lib/capabilities.ts`），一律 deny by default。把出问题的能力改成 `false`，按[智能体上线手册「十、回滚」](../deploy/agent-rollout.md)的方式先备份再 `scripts/app-compose.sh up <project>`。配置写坏服务会拒绝启动而不是降级（[ADR 0001](../adr/0001-capability-config-fails-closed.md)），改完先校验 JSON。
- **下架模型**：在 Admin 的「模型」页把出问题的模型切到下架，写进公开库 `model_availability`（`apps/bff/src/lib/model-availability.ts`），页面和服务端都不再提供它，不用重新发布。
- 止血之后照样按下面的方式回滚或修复，并在汇报里写明止血做了什么、什么时候恢复。

- **常规**：开一个 revert PR，走正常检查和合并，由 Deploy production 发出。它是新提交，不会被「不回退」规则跳过。
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
- **segmenter 全局只有一个实例** `image-playground-segmenter`，内部版、收费版、测试环境共用。只有生产发布会 `up` 它；测试发布只 `attach`，从不构建、启动或替换。不要为某个环境单独起一份，也不要手动 `up`、`rollback`、`detach`。见 `scripts/segmenter-deploy.sh` 开头的说明和 [deploy/segmenter/README.md](../../deploy/segmenter/README.md)。
