# BATCH-07: 发布需求本地草稿保存与列表预览联动

## 本阶段目标

让 `/post` 页面生成的发布草稿临时保存到浏览器本地，并在 `/partners` 页面显示为“我的本地草稿 / 待审核预览”，形成前端 MVP 闭环。

## 本地存储

- localStorage key: `city_partner_local_drafts`
- 本阶段只写浏览器 localStorage。
- 不写数据库。
- 不写 `hermes_jobs`。
- 不触发 Worker 或 Codex 执行队列。

## 草稿字段

- `id`
- `city`
- `category`
- `title`
- `activityTime`
- `expectedPeople`
- `description`
- `contactNote`
- `status`
- `createdAt`

`status` 当前保存为 `pending_review`，用于强调这只是待审核预览，不代表正式发布。

## 页面行为

### `/post`

- 表单校验通过后生成本地草稿。
- 草稿保存到 `city_partner_local_drafts`。
- 页面继续显示成功反馈和预览卡片。
- 成功反馈区提供“去找搭子列表查看”按钮，跳转到 `/partners`。
- 如果 localStorage 不可用，页面仍显示当前页面内预览，并提示当前浏览器无法写入本地草稿。

### `/partners`

- 页面读取本机 localStorage 草稿。
- 在 mock 列表前显示“我的本地草稿 / 待审核预览”区域。
- 草稿卡片明确标注“本地草稿”“待审核”“暂未正式发布”。
- 城市和分类筛选同时影响本地草稿与原有 mock 列表。
- “清空本地草稿”按钮只删除 `city_partner_local_drafts`，不影响任何后端数据。

## 风险与限制

- 本地草稿只存在当前浏览器和当前设备中。
- 清理浏览器数据、切换设备或 localStorage 不可用时可能看不到草稿。
- 正式审核、正式保存和跨设备同步功能需要后续接入后端能力。

## 安全文案

页面继续保留安全提示：

- 线下见面选择公共场所。
- 不提前转账。
- 不泄露身份证、银行卡、住址等隐私。
