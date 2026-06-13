# 飞书自动化规则配置指南

> 4 条规则，配合 Vercel 部署的 city-partner-platform 实现端到端。
> **中转服务 = https://city-partner-platform.vercel.app**

## 架构

```
飞书 Bitable 4 张表
  ├─ 需求池 ─┐
  ├─ 任务看板 ─┤
  ├─ 老板决策 ─┼─→ 飞书自动化 (HTTP POST / 群消息)
  └─ 上线记录 ─┘
       │
       ↓ 自动化 1+2 发 HTTP 到 Vercel
       ↓ 自动化 3+4 直接发群消息 (飞书内置)
       
Vercel API routes:
  POST /api/feishu/requirement    ← 自动化 1 目标
  POST /api/feishu/codex-task     ← 自动化 2 目标
  GET  /api/queue/status          ← 调试用

Supabase (hermes_queue + task_results)
  ↓ 每 5 分钟
GitHub Actions cron (hermes-decompose.yml)
  → 拉 pending → LLM 拆任务 → 写 results → 推群通知 (Bot 1)
```

## 准备: 在 Supabase 建表

跑 `docs/setup-hermes-queue.sql`（一次）

## 准备: Vercel 配 env vars (4 个)

Vercel 项目 `city-partner-platform-tfpf` → Settings → Environment Variables:

| 名字 | 值 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://qfubesklrqoqvuufefvq.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_...` |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_...` |
| `FEISHU_BOT_WEBHOOK` | (Bot 1 群 webhook URL) |

**注意**: `FEISHU_BOT_WEBHOOK` 之前没配到 Vercel，要加。

## 准备: GitHub Secrets (3 个)

仓库 `chengyu1995/city-partner-platform` → Settings → Secrets and variables → Actions:

| 名字 | 值 |
|---|---|
| `SUPABASE_URL` | `https://qfubesklrqoqvuufefvq.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_...` |
| `MINIMAX_CN_API_KEY` | (你 minimax API key) |
| `FEISHU_BOT_WEBHOOK` | (Bot 1 webhook URL) |

## 准备: 部署 Vercel + GitHub Action

```bash
cd E:\projects\city-partner-platform
git add .
git commit -m "feat: 飞书自动化 4 条规则 (Vercel routes + Supabase queue + GH cron)"
git push origin main
```

Vercel 自动 build 新版本（2-3 分钟）。
GitHub Action 第一次会等 5 分钟或你手动 Trigger。

## 飞书 4 条规则

### 自动化 1: 新增需求 → 通知 Hermes

- **触发**: 《需求池》新增记录
- **条件**: 状态 = 待分析
- **动作**: 发送 HTTP 请求
- **URL**: `https://city-partner-platform.vercel.app/api/feishu/requirement`
- **Method**: POST
- **Content-Type**: `application/json`
- **Body**:
  ```json
  {
    "event": "new_requirement",
    "requirement_id": "{{需求 ID}}",
    "title": "{{需求名称}}",
    "description": "{{需求描述}}",
    "priority": "{{优先级}}",
    "acceptance": "{{验收标准}}"
  }
  ```

### 自动化 2: Codex 任务就绪 → 调 Hermes

- **触发**: 《任务看板》记录更新
- **条件**: 状态 = 待执行 AND 执行角色 = Codex
- **动作**: 发送 HTTP 请求
- **URL**: `https://city-partner-platform.vercel.app/api/feishu/codex-task`
- **Body**:
  ```json
  {
    "event": "codex_task_ready",
    "task_id": "{{任务 ID}}",
    "title": "{{任务名称}}",
    "description": "{{任务说明}}",
    "acceptance": "{{输出要求}}",
    "github_issue": "{{GitHub Issue}}"
  }
  ```

### 自动化 3: 老板决策中心新增 → 群通知 (内置群消息)

- **触发**: 《老板决策中心》新增记录
- **条件**: 状态 = 待老板确认
- **动作**: 发送群消息
- **消息**:
  ```
  【需要老板确认】
  问题：{{问题}}
  背景：{{背景}}
  A：{{选项 A}}
  B：{{选项 B}}
  C：{{选项 C}}

  Hermes 建议：{{Hermes 建议}}
  请回复 A / B / C。
  ```

### 自动化 4: 上线记录 = 待上线 → 老板确认 (内置群消息)

- **触发**: 《上线记录》记录更新
- **条件**: 上线状态 = 待上线 AND 是否老板确认 ≠ 是
- **动作**: 发送群消息
- **消息**:
  ```
  【正式上线确认】
  版本：{{版本号}}
  内容：{{上线内容}}
  预览链接：{{Vercel 链接}}

  请确认是否正式上线：
  A：上线
  B：继续修改
  C：暂缓

  注意：未确认前不会发布到生产环境。
  ```

## 验证端到端

1. **手动触发** GitHub Action:
   - https://github.com/chengyu1995/city-partner-platform/actions/workflows/hermes-decompose.yml
   - 点 **Run workflow** → Run

2. **看 Supabase hermes_queue 表**:
   - 应该有 pending → processing → done 流转

3. **看 task_results 表**:
   - 拆解后的总结 + subtasks

4. **看飞书群**:
   - Bot 1 应该推送 "【Hermes 拆任务】..." 卡片

5. **看 Vercel 日志**:
   - /api/queue/status 返回队列状态

## 故障排查

| 现象 | 检查 |
|---|---|
| Vercel 路由 404 | 推代码后 Vercel build 失败？看 build log |
| GitHub Action 报 NO LLM KEY | secrets.MINIMAX_CN_API_KEY 没配 |
| Supabase 写不进去 | RLS policy 错？跑 setup-hermes-queue.sql |
| 群没通知 | FEISHU_BOT_WEBHOOK 没配到 Vercel env？或者 Bot 1 关键词过滤？ |
| Action 跑 8min 超时 | 调小 hermes-decompose.yml 里的 limit |

## 注意

- Vercel **Serverless route** 接收 POST 5 秒内必须返回（Vercel 默认 timeout），所以路由只入队就返回，**不做 LLM 调用**（LLM 在 GitHub Action 里）
- GitHub Action **每 5 分钟**跑一次（不是实时），如果你要更快，改 `cron`（免费 plan 限制最少 5 分钟）
- **自动化 3 + 4 不用 Hermes**——飞书自动化内置"发送群消息"功能，直接配就行
