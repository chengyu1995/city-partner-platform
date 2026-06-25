# 推送指南

## 最快路径（推荐，5 分钟）

### 1. 在 GitHub 网页创建空仓库

打开 https://github.com/new

- **Repository name**: `city-partner-platform`
- **Description** (可选): `MVP 脚手架：Next.js + TS + Tailwind + shadcn/ui + Supabase`
- **Public / Private**: 选你想要的
- ⚠️ **不要勾** "Add a README file"
- ⚠️ **不要勾** "Add .gitignore"
- ⚠️ **不要勾** "Choose a license"
- （本仓库已有这些文件）

点 **Create repository**。

### 2. 创建 GitHub Personal Access Token (PAT)

打开 https://github.com/settings/tokens

- 点 **Generate new token** → **Generate new token (classic)**
- Note: `hermes-push-city-partner`
- Expiration: 你自己定（7 天 / 30 天 / 无）
- Scopes: **只勾 `repo`**
- 点 **Generate token**
- ⚠️ **复制 token 字符串**（只显示一次，刷新页面就看不见）

### 3. 改 `push-to-github.bat`

打开 `C:\Users\admin\city-partner-platform\push-to-github.bat`，把第 11-13 行的占位符替换为：

```bat
set "GITHUB_USER=你的真实GitHub用户名"
set "REPO_NAME=city-partner-platform"
set "GITHUB_TOKEN=ghp_你刚才复制的token"
```

### 4. 双击运行

双击 `push-to-github.bat`，看到 "完成 / 仓库地址" 即成功。

### 5. 验证

打开 `https://github.com/<你的用户名>/city-partner-platform` 应看到 4 个 commits。

## 注意事项

- **PAT 含敏感信息**：`push-to-github.bat` 里会嵌入 token，**别把这个文件 commit 进去**。如果不小心 commit 了，立刻去 https://github.com/settings/tokens 撤销这个 token。
- **HTTPS 凭证**：如果系统记住了别的 GitHub 凭证，git push 可能优先用那个，导致 403。`push-to-github.bat` 已经把 token 拼到 URL 里强制覆盖。
- **后续 push**：以后改完代码，直接 `git push` 就行（凭证在系统里或走 SSH）。

## 如果你不想用 PAT

- 改用 SSH key：https://docs.github.com/en/authentication/connecting-to-github-with-ssh
- 或手动用 GitHub Desktop / VSCode 源码管理面板 push
