# BATCH-10 Local Draft Dedupe And Feedback Notes

## Scope

- Keep `/post` as a local-only MVP submission flow.
- Keep `/partners` local draft preview and the existing clear-local-drafts action.
- Do not write to Supabase, change database schema, change env files, deploy, or add dependencies.

## Dedupe Rule

A local draft is treated as duplicate when all four fields match after trimming surrounding whitespace:

- `city`
- `category`
- `title`
- `description`

When a duplicate is submitted, the existing local draft is reused and no second draft is inserted into localStorage.

## Post Feedback

- New draft saved: `/post` shows `已生成本地草稿，可前往搭子列表预览。`
- Duplicate draft detected: `/post` shows `这条需求已经在本地草稿中，不需要重复提交。`
- The success panel provides two actions:
  - `查看搭子列表`
  - `继续发布新需求`

## Partners Preview

`/partners` still reads local drafts from browser localStorage and keeps the clear button. Drafts are deduped again before rendering, so older duplicated localStorage data does not show repeated cards.

## Data And Env

- Database schema: not modified.
- Supabase write path: not added.
- `.env` files: not modified.
