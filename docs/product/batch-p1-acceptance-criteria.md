# BATCH-P1 验收标准

## 文档状态

- 阶段：BATCH-P1
- 性质：验收标准
- 验收对象：产品范围和页面结构定稿文档

## 必须交付的文档

本批必须只新增或修改以下文件：

- `docs/product/mvp-stage-1-final-plan.md`
- `docs/product/mvp-stage-1-page-structure.md`
- `docs/product/mvp-stage-1-fields.md`
- `docs/product/mvp-stage-1-agent-plan.md`
- `docs/product/mvp-stage-1-batch-plan.md`
- `docs/product/batch-p1-acceptance-criteria.md`

## 内容验收标准

- 最终 MVP 范围已明确。
- 页面清单已明确。
- 字段清单已明确。
- 多 Agent 分工已明确。
- 执行批次建议已明确。
- BATCH-P1 允许修改范围已明确。
- BATCH-P1 禁止修改范围已明确。
- 验收标准已明确。
- 首批城市包含惠州、广州、深圳、上海。
- 城市字段说明保留扩展能力，没有写死只能使用首批城市。
- 首批分类包含饭搭子、运动搭子、学习搭子、出游搭子、K 歌搭子、摩友搭子、钓友搭子。
- 已说明 MVP 第一阶段暂不强制登录，访客可以浏览。
- 已说明发布搭子先做本地草稿 / 待审核流程。
- 已说明真实登录、个人主页、举报、消息通知放到后续阶段。
- 已说明数据库、RLS、生产部署、联系方式安全策略必须后续单独批准。

## 修改范围验收标准

- `git diff --name-only` 只能出现本批允许的 6 个文档文件。
- `git status --short` 只能出现本批允许的 6 个文档文件，或其他已存在的非本任务改动需要明确标注为非本批修改。
- 不应出现 `src/app/page.tsx` 修改。
- 不应出现 `src/app/post/page.tsx` 修改。
- 不应出现 `src/app/partners/page.tsx` 修改。
- 不应出现 `app/page.tsx`、`app/post/page.tsx`、`app/partners/page.tsx` 修改。
- 不应出现数据库、SQL、`.env`、部署配置或业务代码修改。

## 禁止行为验收标准

BATCH-P1 验收必须确认以下事项为“否”：

- 是否修改业务页面：否。
- 是否写 UI 代码：否。
- 是否修改数据库：否。
- 是否执行 SQL：否。
- 是否修改 `.env`：否。
- 是否修改 `.env.local`：否。
- 是否部署：否。
- 是否启动 dev server：否。
- 是否执行 BATCH-P2 到 BATCH-P5：否。

## 静态验证要求

本批只做静态验证：

- 确认 6 个目标文档存在。
- 执行 `git diff --name-only`。
- 执行 `git status --short`。
- 确认没有业务页面修改。
- 不启动浏览器。
- 不启动本地 dev server。
- 不部署。

## 通过标准

当 6 个目标文档存在且内容覆盖 BATCH-P1 目标，同时 Git 变更范围没有超出允许文件，即可判定 BATCH-P1 文档阶段通过。

如果静态诊断发现本地已有非本任务改动，应记录 warning 并区分来源；不能为了 BATCH-P1 擅自还原或修改非任务文件。
