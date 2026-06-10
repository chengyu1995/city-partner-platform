# 同城搭子平台 (city-partner-platform)

> MVP 脚手架。技术栈：**Next.js 16 + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui**。
> 后续接 Supabase + Vercel。

## 本地开发

```bash
npm install          # 已 init 过的话 skip
npm run dev          # 起开发服 → http://localhost:3000
```

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动 Next.js dev server |
| `npm run build` | 生产构建 |
| `npm start` | 跑生产构建 |
| `npm run lint` | ESLint 检查 |

## 目录结构

```
.
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx             # 首页（同城搭子）
│   │   ├── globals.css          # Tailwind v4 + shadcn 主题
│   │   └── activities/page.tsx  # 活动列表（mock 数据）
│   ├── components/ui/           # shadcn/ui 组件：button / card / input / label
│   └── lib/
│       ├── utils.ts             # cn() helper
│       └── supabase/            # Supabase client（browser + server）
├── components.json              # shadcn/ui 配置
├── AGENTS.md / CLAUDE.md        # 给 AI agent 看的项目说明（Next.js 16 自带）
└── .env.example                 # Supabase 变量占位
```

## 推到 GitHub

本地仓库已 init 完毕。两种推法：

### 方式 A：手动（30 秒）
1. https://github.com/new → Repository name `city-partner-platform` → 不勾任何初始化
2. 按 GitHub 提示：
   ```bash
   cd /c/Users/admin/city-partner-platform
   git remote add origin https://github.com/<your-username>/city-partner-platform.git
   git push -u origin main
   ```

### 方式 B：贴 PAT 让我推
去 https://github.com/settings/tokens → Generate new token (classic, 勾 `repo`) → 贴给 hermes。

## 接到 Vercel

1. https://vercel.com → Add New Project → Import Git Repository → 选 `city-partner-platform`
2. Framework Preset 自动识别为 Next.js
3. Environment Variables 填：
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Deploy

## 接到 Supabase

1. https://supabase.com → New Project（选 Northeast Asia / Singapore）
2. SQL Editor 建表：
   ```sql
   create table activities (
     id uuid default gen_random_uuid() primary key,
     title text not null,
     starts_at timestamptz not null,
     location text,
     capacity int default 10,
     created_at timestamptz default now()
   );
   ```
3. 项目 URL + anon key 填到 Vercel env vars

## 下一步

- [ ] 接到 Supabase 真实数据（替换 `app/activities/page.tsx` 的 MOCK）
- [ ] 接登录（决策 MVP 是否先做，见 Bitable 投票）
- [ ] 接入飞书通知机器人（任务拆完回写群）
- [ ] 接入飞书需求池 webhook（已在 Hermes 端搭好）
- [ ] 用 Codex 拆任务 → PR 流程
