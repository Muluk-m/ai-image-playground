# packages/db

PostgreSQL schema、Drizzle migration 和连接池。迁移由 `src/migrate.ts` 在发布时加锁执行。

## 迁移序号 13 和 80 是历史空缺

`drizzle/meta/_journal.json` 的 `idx` 没有 13 和 80。对应的 SQL 文件也不存在：`0012_flowery_viper` 的下一条是 `0014_agent_task_link`，`0079_task_metering` 的下一条是 `0081_cli_device_oauth`。文件集是齐的，不是漏跑了一条迁移。

不要补 `0013` 或 `0080` 去填这个洞。Drizzle 按 journal 的 `when` 决定哪些还没跑；把一个新迁移插进历史序号，会让已经应用过的库把顺序看乱（2026-10-27 测试环境因此中断过）。新迁移接在当前最大编号之后，并带上同名的 `rollback/*.down.sql`。

已在测试库或生产库应用过的迁移不改号、不挪 `when`。细节见仓库根 `AGENTS.md`「改迁移编号前先查两个库」。
