# 删除 Vercel 旧项目 `city-partner-platform-tfpf`

> 主域名 `https://city-partner-platform.vercel.app` 已经 production-ready
> 旧项目 `city-partner-platform-tfpf` 是创建主项目时残留的重复项目, 需要删除避免混淆

## ⚠️ 删除前确认

- [ ] 主域名 `https://city-partner-platform.vercel.app` **已 production-ready**
- [ ] 域名已正确指向主项目 (`city-partner-platform`, 不是 `-tfpf`)
- [ ] 不再有 traffic 走到 `-tfpf.vercel.app`
- [ ] 备份了任何**非 GitHub** 里的 env vars / domain settings

## 操作步骤

1. 打开 https://vercel.com/dashboard
2. 找到 **`city-partner-platform-tfpf`** 项目卡片
3. 点进项目
4. 顶栏 **Settings** → **General**
5. 滚到最底部 **"Delete Project"** 危险区
6. 输入项目名 `city-partner-platform-tfpf` 确认
7. 点 **Delete**

## 删除后验证

- [ ] 访问 https://city-partner-platform-tfpf.vercel.app → 应该 404
- [ ] 主域名 https://city-partner-platform.vercel.app 仍正常
- [ ] 部署列表里只剩一个 `city-partner-platform` 项目

## 回滚

如果你**删错了**:
- Vercel 团队版/Pro 版可以从 trash 恢复
- **Hobby (免费) 版** 删了就是删了, 无法恢复
- 你当前在 FREE plan, **建议先截图保存任何重要 env vars / domain settings 再删**
