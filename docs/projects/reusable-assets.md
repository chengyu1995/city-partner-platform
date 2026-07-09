# 可复用资产盘点

## 同城搭子网站当前可直接复用内容

### 页面与流程
- 首页基础入口：可作为平台总入口继续使用。
- 搭子分类方向：旅游搭子、K歌搭子、学习搭子、运动搭子、出游搭子、摩友搭子、钓友搭子可继续作为首批兴趣分类。
- 城市范围：惠州、广州、深圳、上海可作为首批城市。
- 访客浏览机制：`/partners` 方向可以继续作为游客浏览搭子需求的基础。
- 本地草稿/待审核流程：`/post` 当前可作为用户提交搭子需求的早期 MVP 流程。
- 联系方式暂不公开策略：符合“后续单独确认”的安全边界。

### 自动化系统可复用能力
- 飞书老板控制台：老板只需要在飞书群里发需求和批准。
- 项目总管模式：总管负责分类、分发、跟踪、汇总，不直接做产品规划或代码。
- 腾讯云中转站：作为飞书事件、任务队列、Worker 上报的中转核心。
- Windows Worker：可领取任务、调用 Codex、执行校验、提交和上报。
- Git 安全闸门：能阻止越权修改业务页面、环境变量、数据库和错误提交。
- read_only / docs_write_allowed / automation_system_write_allowed 任务模式已经形成基础规则。

## 可继续复用的文档
- docs/PROJECT_INDEX.md
- docs/CURRENT_STATE.md
- docs/DECISIONS.md
- docs/BATCH_LOG.md
- docs/ACCEPTANCE_LOG.md
- docs/TROUBLESHOOTING.md
- docs/projects/city-partner-website.md
- docs/projects/feishu-gm-automation.md
