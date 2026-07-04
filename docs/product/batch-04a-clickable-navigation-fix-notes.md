# BATCH-04A 点击跳转修复记录

## 修复范围

- 首页顶部导航补齐可点击入口：分类、推荐、发布需求。
- 首页首屏按钮、城市入口、分类卡片、推荐卡片均使用 Next.js `Link` 跳转。
- `/partners` 城市筛选、分类筛选、清除筛选均使用明确的 `Link` 跳转。

## 首页入口映射

- 分类：`/partners`
- 推荐：`/partners`
- 发布需求：`/post`
- 找搭子：`/partners`
- 当前城市杭州：`/partners?city=杭州`
- 热门城市：`/partners?city=城市名`
- 分类卡片：`/partners?category=分类名`
- 推荐搭子卡片：`/partners?category=分类名&city=城市名`

## /partners 入口映射

- 城市筛选：`/partners?city=城市名`
- 分类筛选：`/partners?category=分类名`
- 全部城市：`/partners`
- 全部分类：`/partners`
- 清除筛选：`/partners`
- 推荐卡片按钮：`/partners?city=城市名&category=分类名`

## 未修改内容

- 未修改数据库结构。
- 未执行 SQL。
- 未修改 `.env`。
- 未接入真实后端数据。
- 未修改登录、注册、个人主页、发布页业务逻辑。
- 未引入新依赖。
