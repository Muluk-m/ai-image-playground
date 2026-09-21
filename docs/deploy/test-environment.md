# 测试环境（test 分支 → test.muvloom.online）

生产发布看 [image-release.md](image-release.md)，这份只讲测试环境。

## 它是什么

`test` 分支上的每一次推送，由 `.github/workflows/deploy-test.yml` 自动发布到 **https://test.muvloom.online**。

它是一个**独立的 Cloudflare Pages 项目**（`muvloom-test`），和付费站 `muvloom.online` 在同一个账号下，但项目、域名、部署互不相干。不用预览别名（`<branch>.<project>.pages.dev`），因为预览别名挂不了自定义域名。

发的是**付费形态的包**（带 private overlay）：这个站的作用就是看「下一次发到 muvloom.online 会是什么样」，形态不一样就没有参照价值。

只发前端。**没有测试后端**——见下面「它连的是哪套 API」。

| | 生产（付费） | 测试 |
| --- | --- | --- |
| 域名 | muvloom.online | test.muvloom.online |
| Pages 项目 | `ai-image-playground` | `muvloom-test` |
| 触发 | 合 `main` | 推 `test` |
| 入口 | `scripts/pages-release.sh paid` | `scripts/pages-release.sh test` |
| 后端 | VPS 上跟着一起发 | 不发，连生产 API |

## 一次推送经过什么

| 步骤 | 做什么 | 失败会怎样 |
| --- | --- | --- |
| `checks` | `scripts/ci-check-test-branch.sh`：`test` 落后 `origin/main` 就直接失败；随后 `pnpm lint`、`pnpm typecheck`、`pnpm --dir apps/web build` | 不发布 |
| `publish` | 克隆 private overlay 的 main HEAD，`scripts/pages-release.sh test` | 不发布 |

三件事值得单独说清：

- **落后 main 为什么是失败而不是自动合。** 一个落后 main 的测试站展示的是谁也不会上线的行为，而这个差异在页面上完全看不出来。让 CI 自己合，就意味着无人看管地解冲突——在两份同名改动之间做决定，猜错的结果是测试站跑着一份哪里都不存在的代码。红灯就是信号：把 main 合进 `test` 再推一次。
- **失败信息直接给缺了哪几条提交**，不只报一个数字，省得再去翻 `git log`。
- **两个 job 都 checkout `github.sha`，不是分支尖端。** 否则运行期间落下的一次推送会被 `publish` 直接发出去，而它从没被 `checks` 检过——2026-09-21 就这么把一个未检的提交发上了测试站。新推送由它自己那次运行发布。

不跑 bff 测试集：这条链路不发任何后端，而 `Web checks` 已经在每个进 main 的 PR 上跑过它。

## 它连的是哪套 API

`TEST_BFF_BASE_URL`，目前指向 `https://api.muvloom.online`——**付费站的生产 API**。

**测试站读写的是生产数据。** 浏览器本地存储是隔离的（另一个域名，登录态与 IndexedDB 都不共享），但服务端那一份不是：在测试站点一次生成，扣的是生产的积分、进的是生产的库。

要一套独立数据，就得先有一个测试 API，再把 `TEST_BFF_BASE_URL` 指过去。那是另一块基建，不在这条链路里。

另外两项刻意留空，CI 里也显式清掉：

- `TEST_EXTRA_ASSETS_DIR`：测试站不发运营素材（付费站的二维码之类）。
- `TEST_NOTIFY_UPDATE`：测试站发布绝不弹生产标签页的更新提示。

### 新域名必须先进 API 的 CORS 白名单

测试站是另一个 origin，付费 BFF 默认不认它。不加，浏览器会拦掉 `/api/capabilities`，前端把「取不到能力」当成「没配 API」，界面显示**「请先在设置里配置 API」**——看起来像前端坏了，其实是后端没放行。

VPS 上 `~/.config/ai-image-playground/apps/image-playground-paid/app.env` 的 `CORS_ALLOWED_ORIGINS` 要含 `https://test.muvloom.online`（顺带 `https://muvloom-test.pages.dev`，直连 Pages 域名调试时用）。

**改完 `app.env` 之后 `docker restart` 不生效。** 环境变量在容器创建时就固定了，重启只是重跑同一份。必须起一代新运行时：

```sh
cd ~/releases/<最近一次 release>
DEPLOY_ACTOR=<原因> ./scripts/rollout-runtime.sh image-playground-paid <当前镜像 tag>
```

镜像 tag 取 `docker inspect --format '{{.Config.Image}}' <当前 bff 容器>`，**不要用 `app.env` 里的 `APP_IMAGE`**，那一行可能是旧的。旧一代会正常排空，不掉在途任务。

验证一句话：

```sh
curl -sI -H 'Origin: https://test.muvloom.online' https://api.muvloom.online/api/capabilities | grep -i access-control-allow-origin
```

没有这一行就是没放行。R2 不需要另配：图片经 `/api/result` 由 BFF 读对象存储后转发（`apps/bff/src/routes/result.ts:125,213`），浏览器不直连存储桶。

## 手动发一次

CI 挂了的时候，在能发布付费站的那台机器上（要有 `./private`）：

```sh
./scripts/pages-release.sh test
```

读的是同一份 `$XDG_CONFIG_HOME/ai-image-playground/pages.env` 的 `TEST_*` 段。

## 不要做的事

- **不要用 `scripts/pages-deploy.sh` 手动发。** 它是底层命令，漏掉第三个参数的历史后果是「把未合并的分支发到了生产」（脚本里那段注释就是为此写的）。上层入口只有 `pages-release.sh`，靠 `internal|paid|test` 选目标，每个目标的项目与域名都在 pages.env 里各自写死。
- **不要把 `test` 当长期集成分支往里合功能。** 它的作用是「main 的一个可点的快照，外加正在验的那几个改动」。合完 main 之后它应该很快回到与 main 一致。
- **不要在 `test` 上直接改代码。** 那些提交进不了 main，只会让下一次合 main 更难。

## Secrets 与基础设施

workflow 用的都是已有的 secret，**没有新增**：

| Secret | 用途 |
| --- | --- |
| `PAGES_ENV` | `TEST_PAGES_PROJECT` / `TEST_BFF_BASE_URL` / `TEST_PUBLIC_ORIGIN` / `TEST_CLOUDFLARE_ACCOUNT_ID` |
| `PAID_CLOUDFLARE_API_TOKEN` | 测试项目与付费站在同一个 Cloudflare 账号 |
| `PRIVATE_OVERLAY_SSH_KEY` | 测试站是付费形态，要 overlay |

workflow 是只读的（`contents: read`）：它不改任何分支，落后 main 时只是失败。

已经建好的 Cloudflare 资源（2026-09-20，账号 `252fba81…`）：

- Pages 项目 `muvloom-test`，生产分支 `main`
- 自定义域名 `test.muvloom.online`
- `muvloom.online` 区里的 CNAME `test → muvloom-test.pages.dev`（已代理）
