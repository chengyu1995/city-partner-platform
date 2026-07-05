# 同城搭子网站 MVP 第一阶段字段清单

## 文档状态

- 阶段：BATCH-P1
- 性质：字段规划，不修改数据库
- 说明：本文只定义 MVP 字段，不执行 SQL、不修改 Supabase、不修改 RLS

## 字段设计原则

- 城市字段保留扩展能力，首批城市只是初始选项。
- 分类字段保留扩展能力，首批分类只是初始选项。
- 本阶段先支持访客浏览和本地草稿 / 待审核发布。
- 联系方式只定义字段，不在本阶段实现安全策略。
- 后续接数据库时再决定字段类型、索引、RLS 和审核流。

## 搭子需求字段

| 字段 | 建议字段名 | 类型建议 | 必填 | 用途 |
| --- | --- | --- | --- | --- |
| 唯一标识 | `id` | string | 后续需要 | 标识单条搭子需求 |
| 标题 | `title` | string | 是 | 列表和详情主标题 |
| 城市 | `city` | string | 是 | 首批展示惠州、广州、深圳、上海，但不写死限制 |
| 分类 | `category` | string | 是 | 饭搭子、运动搭子、学习搭子、出游搭子、K 歌搭子、摩友搭子、钓友搭子 |
| 地点 | `location` | string | 是 | 商圈、地标或集合地点 |
| 开始时间 | `starts_at` | string / datetime | 是 | 活动或需求开始时间 |
| 结束时间 | `ends_at` | string / datetime | 否 | 活动结束时间，MVP 可选 |
| 期望人数 | `capacity` | number | 是 | 总人数或期望人数 |
| 已有人数 | `joined_count` | number | 否 | 后续展示热度或进度 |
| 需求说明 | `description` | string | 是 | 详细说明活动内容和要求 |
| 标签 | `tags` | string[] | 否 | 后续用于筛选和推荐 |
| 预算说明 | `budget_note` | string | 否 | AA、免费、预算范围等 |
| 适合人群 | `target_people` | string | 否 | 年龄、经验、偏好等非敏感描述 |
| 注意事项 | `notes` | string | 否 | 风险提示、装备要求、迟到规则等 |
| 发布人昵称 | `host_name` | string | 是 | 不强制登录时的展示名 |
| 联系方式类型 | `contact_type` | string | 是 | 微信、手机号、其他方式等 |
| 联系方式内容 | `contact_value` | string | 是 | 本阶段只保存草稿/待审核，不直接设计公开策略 |
| 发布状态 | `status` | string | 是 | `draft`、`pending_review`、`published`、`rejected` |
| 来源 | `source` | string | 否 | local、mock、supabase 等后续扩展 |
| 创建时间 | `created_at` | string / datetime | 后续需要 | 排序和审计 |
| 更新时间 | `updated_at` | string / datetime | 后续需要 | 后续编辑和审核 |

## 城市字段

首批城市：

- 惠州
- 广州
- 深圳
- 上海

建议字段为 `city: string`。不要把数据库、类型或业务逻辑限制成只能取这 4 个值。后续可以扩展：

- `province`
- `district`
- `area`
- `geo_lat`
- `geo_lng`
- `city_code`

## 分类字段

首批分类：

- 饭搭子
- 运动搭子
- 学习搭子
- 出游搭子
- K 歌搭子
- 摩友搭子
- 钓友搭子

建议 MVP 先使用 `category: string`。后续如需要稳定配置，可以扩展为：

- `category_key`
- `category_label`
- `category_icon`
- `category_sort`
- `category_enabled`

## 状态字段

MVP 第一阶段发布流程建议使用以下状态概念：

| 状态 | 含义 | 本阶段处理 |
| --- | --- | --- |
| `draft` | 本地草稿，用户尚未提交 | 可以作为本地保存状态 |
| `pending_review` | 已提交，等待审核 | 只定义流程，不接真实审核系统 |
| `published` | 已公开 | 后续批次实现 |
| `rejected` | 审核拒绝 | 后续批次实现 |

## 暂不定义为数据库结构

本文不是数据库 schema。字段命名和类型供后续 BATCH 使用，不能在 BATCH-P1 执行 SQL、修改 Supabase 表、修改 RLS 或改生产数据。
