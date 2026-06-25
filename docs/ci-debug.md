# CI 调试 — 为什么还在 fail

## 当前情况

- 本地 `npm run lint` ✅ 0 errors (8 warnings)
- 本地 `npx tsc --noEmit` ✅ 通过
- 本地 `npm run build` ✅ 通过
- **CI 仍 fail**

## 你要做的 (2 分钟)

1. 打开 https://github.com/chengyu1995/city-partner-platform/actions
2. 点最新 failed workflow (commit `159d120`)
3. 找红 ❌ 的 step
4. 展开看日志
5. 截屏发我

## 最常见 fail 原因

按概率:

1. **TypeScript strict mode** — `tsc --noEmit` 报错 (本地过但 CI 上没设某些 flag?)
2. **Edge runtime 问题** — `runtime = 'edge'` 路由在 CI 上不能编译 (本地是 node)
3. **依赖装错了** — `package-lock.json` 跟 `package.json` 不一致
4. **`'use client'` 边界** — `'use client'` 文件用了 server-only API
5. **Build memory 不够** — Vercel CI runner 默认 7GB, 大项目可能 OOM

## 我会快速修

等你贴 log 给我看, 50% 概率是上面 5 个之一, 我直接修.
