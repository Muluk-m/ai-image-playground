# 公告发布

库存四态。到点是否公开由 `effectiveAnnouncementStatus` 按 `publishAt` / `expireAt` 计算，不改这一列。转移表：`packages/shared/src/machines/announcement.ts`。

```mermaid
stateDiagram-v2
  [*] --> draft
  draft --> published: publish
  draft --> scheduled: schedule
  draft --> archived: archive
  scheduled --> published: publish
  scheduled --> scheduled: schedule
  scheduled --> draft: unpublish
  scheduled --> archived: archive
  published --> published: publish
  published --> scheduled: schedule
  published --> draft: unpublish
  published --> archived: archive
  archived --> archived: archive
```

`revise` 是自环，只在 draft / scheduled / published 上成立，用来挡住对已归档公告的改正文。已归档不能发布或撤回。
