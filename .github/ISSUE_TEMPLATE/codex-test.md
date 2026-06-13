---
name: Codex 集成测试
about: 验证 OpenAI Codex GitHub App 是否正常接到任务
title: '[codex-test] '
labels: ['codex-test', 'verification']
assignees: []
---

## 测试目的

按 `docs/CODEX_SETUP.md` 步骤 4 验证 Codex GitHub App 集成是否成功。

## 预期行为

提交后 1-2 分钟内, OpenAI Codex bot 应该在 issue 评论里回复类似:
- "I'll take this" 或 "已接到"
- 显示 Codex 的 GitHub username (一般是 `chatgpt-codex` 或 `codex-bot`)

如果 5 分钟内没评论 → 集成失败, 按 `docs/CODEX_SETUP.md` 排查。

## Codex 任务说明 (这个 issue 不需要真改代码)

只需要 Codex 评论"已接到", **不要**:
- 不要创建 PR
- 不要改代码
- 不要修改这个 issue 的内容

## 验收标准

- [ ] Codex 在 issue 评论里出现
- [ ] 评论里能看到 Codex bot username
- [ ] 没创建意外 PR

## 关联

- `docs/CODEX_SETUP.md`
- `AGENTS.md`

## 测试结束后

- 如果成功: 把这个 issue 标为 `done` 或关闭
- 如果失败: 检查清单
  - [ ] GitHub App 是否装? https://github.com/settings/installations
  - [ ] Repository access 是否选 chengyu1995/city-partner-platform
  - [ ] 6 个权限是否勾 (2b 表)
  - [ ] Codex 评论权限是否给
