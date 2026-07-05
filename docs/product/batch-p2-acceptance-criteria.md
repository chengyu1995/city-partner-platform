# BATCH-P2 验收标准

## 文档状态

- 阶段：BATCH-P2
- 性质：验收标准
- 验收对象：页面信息架构、页面文案、状态文案、移动端信息优先级文档
- 本批不写 UI 代码，不修改业务页面，不修改数据库，不部署

## 必须交付的文档

本批只能新增或修改以下文件：

- `docs/product/mvp-stage-1-information-architecture.md`
- `docs/product/mvp-stage-1-page-copy.md`
- `docs/product/mvp-stage-1-state-copy.md`
- `docs/product/mvp-stage-1-mobile-priority.md`
- `docs/product/batch-p2-acceptance-criteria.md`

## 内容验收标准

- 已明确首页 `/` 的信息架构和信息层级。
- 已明确搭子列表页 `/partners` 的信息架构和卡片信息层级。
- 已明确发布搭子页 `/post` 的信息架构和表单信息层级。
- 已提供首页、列表页、发布页的页面文案。
- 已提供空状态、加载状态、错误状态、成功状态文案。
- 已提供发布状态文案，包括草稿、待审核、已发布、未通过、已结束等概念。
- 已提供表单校验文案。
- 已明确 375px 移动端的信息优先级和页面顺序。
- 已包含首批城市：惠州、广州、深圳、上海。
- 已包含首批分类：饭搭子、运动搭子、学习搭子、出游搭子、K 歌搭子、摩友搭子、钓友搭子。
- 已说明 MVP 第一阶段暂不强制登录，访客可以浏览。
- 已说明发布搭子先做本地草稿 / 待审核流程。
- 已说明数据库、RLS、生产部署、联系方式安全策略必须后续单独批准。
- 已提供下一批 BATCH-P3 的建议。

## 修改范围验收标准

- `git diff --name-only` 只能出现本批允许的 5 个文档文件。
- `git status --short` 只能出现本批允许的 5 个文档文件，或其他已存在的非本任务改动需要明确标注为非本批修改。
- 不应出现 `src/app/page.tsx` 修改。
- 不应出现 `src/app/post/page.tsx` 修改。
- 不应出现 `src/app/partners/page.tsx` 修改。
- 不应出现 `app/page.tsx`、`app/post/page.tsx`、`app/partners/page.tsx` 修改。
- 不应出现数据库、SQL、`.env`、`.env.local`、部署配置或业务代码修改。

## 禁止行为验收标准

BATCH-P2 验收必须确认以下事项为“否”：

- 是否修改业务页面：否。
- 是否写 UI 代码：否。
- 是否修改数据库：否。
- 是否执行 SQL：否。
- 是否修改 `.env`：否。
- 是否修改 `.env.local`：否。
- 是否部署：否。
- 是否启动 dev server：否。
- 是否执行 BATCH-P3 到 BATCH-P5：否。
- 是否创建 Git commit：否，由外层 Worker 处理。
- 是否 push：否，由外层 Worker 处理。

## 静态验证要求

本批只做静态验证：

- 确认 5 个目标文档存在。
- 执行 `git diff --name-only`。
- 执行 `git status --short`。
- 确认实际执行批次与老板批准批次一致：BATCH-P2。
- 确认没有超出允许范围。
- 确认 `/`、`/partners`、`/post` 页面代码未修改。
- 确认没有修改数据库、`.env` 或部署配置。
- 不启动浏览器。
- 不启动本地 dev server。
- 不部署。

## 通过标准

当 5 个目标文档存在且内容覆盖 BATCH-P2 目标，同时 Git 变更范围没有超出允许文件，即可判定 BATCH-P2 文档阶段通过。

如果静态诊断发现本地已有非本任务改动，应记录 warning 并区分来源；不能为了 BATCH-P2 擅自还原或修改非任务文件。

## 是否可以进入 BATCH-P3

满足以下条件后，可以向老板建议进入 BATCH-P3：

- BATCH-P2 的 5 个文档验收通过。
- 老板确认可以把文档转为页面 UI 实现。
- BATCH-P3 仍需单独批准后才能执行。
- BATCH-P3 不应默认接数据库、登录、审核后台、联系方式安全策略或生产部署。
