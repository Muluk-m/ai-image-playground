# 灵感库（探索页素材流）维护手册

适用于批量下架、恢复、新增灵感条目。单条操作直接用 Admin 后台「灵感库」即可。

## 数据与发布

- 条目在 `inspiration_items`，分类在 `inspiration_categories`。状态：`draft` / `published` / `archived`。
- 前台读 BFF `GET /api/inspirations/manifest`，只含 `published`；每次改状态或内容都会写 `operator_audits` 并生成新的
  `inspiration_publications` 版本。前台分类由已发布条目推导，某分类全部下架后自动消失。
- manifest 与图片都经 Cloudflare 缓存，改完最多约 5 分钟后前台才一致。
- `cover_key` / `image_key` 可以是 key，也可以是完整 URL：完整 `http(s)` URL 原样输出，否则拼 `PUBLIC_ASSET_BASE_URL`。
  现有条目统一用完整 URL：`image_key` = 原图 URL，`cover_key` = 同一 URL 加 `?w=320&q=85`（Cloudflare 缩略图）。
- 「下架」= 改成 `archived`，记录、提示词、图片都保留，可随时恢复。已发布条目必须先下架才能删除；批量维护只下架，不硬删。

## 图片放哪里（重要）

- 灵感图一律上传到 **`cms-r2.deepclick.com`**，用 cms CLI：`~/.claude/skills/cms/scripts/cms.sh media upload`，记下返回的 URL。
- **不要**用 BFF 上传（`POST /internal/admin/inspirations/uploads`，即 `inspiration-add.ts` 的上传）或 `assets.muvloom.online`：
  生产的 R2 上传端点（S3 凭据）和 `PUBLIC_ASSET_BASE_URL`（assets.muvloom.online）属于**两个不同的 Cloudflare 账号**，
  文件传进去了，公开域名却是另一个空桶，全部 404，而且 404 会被 CDN 缓存 4 小时。修好这个配置之前，Admin 里新建条目上传图片同样会 404。
- Cloudflare WAF 可能拦截个别文件的上传（2026-10-20 77 张里拦了 6 张）。不要绕过，换图或重新生成后再传，被拦的条目保持下架。
- 测试环境没有配置公开素材桶（`PUBLIC_ASSET_BUCKET` / `PUBLIC_ASSET_BASE_URL` 为空），新图无法在测试环境走 BFF 上传。

## 脚本

都在 `apps/bff/scripts/`，默认 dry run，加 `--apply` 才写库，`--operator` 写审计。

- 参数解析是严格的：未知选项（含 `--key=x` 写法和拼错的选项）、带值选项缺值或值以 `-` 开头都会直接报错退出，不会写库。
- `inspiration-status.ts <ids.json> [--key remove] [--restore] [--apply]`：在一个事务里批量下架；`--restore` 把 `archived` 恢复为 `published`。
  `ids.json` 可以是 id 数组，或含多个列表的对象（用 `--key` 选）。`--apply` 时在事务内重新读取并锁定这些行，重复执行只会变更 0 条。
  `--restore` 只恢复**曾经发布过**（`published_at` 非空）且仍通过 Admin 发布校验（字段、渠道里有该模型、技能存在）的条目；
  从没发布过的草稿、下架期间被改坏的条目会列为 `blocked` 并保持下架，dry run 里就能看到原因。
- `inspiration-add.ts <dir> [--apply] [--publish]`：按 `<dir>/items.json` 建草稿，可选发布。它的上传走 BFF（见上，目前不可用），
  `--apply` 一定会先走 BFF 上传，所以要在下面的「一次性容器」里跑。现在新增的流程是：用 cms CLI 把图传到 cms-r2 →
  在一次性容器里跑本脚本建草稿（**不要** `--publish`；它上传到的那个桶前台读不到，无所谓）→ 用 `inspiration-repoint.ts`
  改成 cms 的 URL → 核对 URL 都是 200 → `inspiration-status.ts --key <新增列表> --restore --apply` 发布（草稿状态的条目先用 Admin 发布，
  或沿用 2026-10-20 的做法：先发布后立即整体下架，再 repoint、restore）。
  `items.json` 每项：`{ id, title, prompt, category, size, file, featured?, sort?, tags?, description? }`，`category` 必须是已有分类名，
  `sort` 越小越靠前（整数）。模型固定 `openai-compat` / `gpt-image-2.5-flare`。上传前先整体校验（字段类型、重复 id、文件、分类，
  `--publish` 时还会预跑发布校验含模型），有任何问题都不会上传。已存在的 id：本脚本建的同内容草稿会续跑，同内容已发布的跳过；
  归档条目、内容不同或别人建的草稿一律报冲突并中止——归档条目只能用 `inspiration-status.ts --restore` 显式恢复。
- `inspiration-repoint.ts <map.json> [--apply]`：走 `updateInspirationItem`（与 Admin 编辑同一路径）改 `cover_key` / `image_key`，
  `map.json` 形如 `{ "<id>": { "cover": "<url>?w=320&q=85", "image": "<url>" } }`，两个 URL 都必须是 https。
  已发布条目更新时会重跑发布校验（需要容器里的渠道配置），dry run 会提前报出；已指向目标 URL 的条目跳过，可重复执行。
  每条更新各自刷新一次 publication，条目多时版本号会连续递增，属正常现象。

## 在生产 / 测试上运行

脚本只能在 VPS 的容器里跑（需要数据库）。用 `migrate` 服务，它自带迁移账号，**不要读取或拷贝任何凭据**。
测试环境把 `image-playground-paid` 换成 `image-playground-test`。

```sh
# 本机：把脚本和数据打成 bundle.tar（放在仓库外或 .gitignore 的临时目录，不要提交）
REL=$(ssh tx-vps "docker inspect image-playground-paid-admin-1 --format '{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}'" | sed 's#/deploy$##')
IMG=$(ssh tx-vps "docker inspect image-playground-paid-admin-1 --format '{{.Config.Image}}'")
RUN="cd $REL && APP_IMAGE=$IMG scripts/app-compose.sh compose image-playground-paid run --rm -T --no-deps migrate sh -c"
PREP='mkdir -p /tmp/b && tar -x -C /tmp/b && cp /tmp/b/inspiration-*.ts /app/apps/bff/scripts/ && cd /app/apps/bff &&'
ssh tx-vps "$RUN \"$PREP bun run scripts/inspiration-status.ts /tmp/b/ids.json --operator <你的名字>\"" < bundle.tar
```

- `migrate` 只在内部网络 `application-infra` 上，**没有外网**（连 DNS 都解析不了）。只改数据库的步骤（status、repoint、不上传的 add）照上面跑即可。
  需要外网时（例如 BFF 上传），起一个一次性容器并临时接入 `application` 网络，用镜像自己的 entrypoint 执行（它负责设置 `DATABASE_URL`）：
  ```sh
  ssh tx-vps "cd $REL && APP_IMAGE=$IMG scripts/app-compose.sh compose image-playground-paid run -d --rm --no-deps --name insp-oneoff migrate sleep 1800 \
    && docker network connect image-playground-paid_application insp-oneoff"
  ssh tx-vps "docker exec -i insp-oneoff /usr/local/bin/docker-entrypoint.sh sh -c '$PREP bun run scripts/...'" < bundle.tar
  ssh tx-vps "docker stop insp-oneoff"
  ```
  不要改 compose 文件、env 或正在运行的服务。

## 流程与验收

1. **先测试，后生产**；生产操作要有负责人明确同意。每一步先 dry run，核对数量（将改 N 条、缺失 0）再 `--apply`。
2. 验收：
   - `curl -s https://api.muvloom.online/api/inspirations/manifest?t=$(date +%s)`：条目数符合预期，下架的 id 不在、新增的 id 都在，版本号递增。
   - 新增条目的 `thumbnailUrl` 和 `imageUrl` 全部返回 200。
   - 打开 https://muvloom.online/explore ，桌面 1440 和手机 390 各滚完整个列表，不能有灰色空白卡片。
3. 回滚：
   - 恢复下架：`inspiration-status.ts ids.json --key remove --restore --apply`。
   - 撤掉新增：把新增 id 放进 `ids.json` 的另一个 key（如 `added`），`inspiration-status.ts ids.json --key added --apply`。
   - 图片坏了先立刻把相关条目下架，再查原因。
